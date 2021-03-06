'use strict';
import { Functions, Iterables } from './system';
import { CancellationToken, CodeLens, CodeLensProvider, Command, commands, DocumentSelector, Event, EventEmitter, ExtensionContext, Position, Range, SymbolInformation, SymbolKind, TextDocument, Uri, workspace } from 'vscode';
import { Commands, DiffWithPreviousCommandArgs, ShowBlameHistoryCommandArgs, ShowFileHistoryCommandArgs, ShowQuickCommitDetailsCommandArgs, ShowQuickCommitFileDetailsCommandArgs, ShowQuickFileHistoryCommandArgs } from './commands';
import { BuiltInCommands, DocumentSchemes, ExtensionKey } from './constants';
import { CodeLensCommand, CodeLensLocations, ICodeLensLanguageLocation, IConfig } from './configuration';
import { GitBlame, GitBlameCommit, GitBlameLines, GitService, GitUri } from './gitService';
import { Logger } from './logger';

export class GitRecentChangeCodeLens extends CodeLens {

    constructor(private blame: () => GitBlameLines | undefined, public uri: GitUri, public symbolKind: SymbolKind, public blameRange: Range, public isFullRange: boolean, range: Range) {
        super(range);
    }

    getBlame(): GitBlameLines | undefined {
        return this.blame();
    }
}

export class GitAuthorsCodeLens extends CodeLens {

    constructor(private blame: () => GitBlameLines | undefined, public uri: GitUri, public symbolKind: SymbolKind, public blameRange: Range, public isFullRange: boolean, range: Range) {
        super(range);
    }

    getBlame(): GitBlameLines | undefined {
        return this.blame();
    }
}

export class GitCodeLensProvider implements CodeLensProvider {

    private _onDidChangeCodeLenses = new EventEmitter<void>();
    public get onDidChangeCodeLenses(): Event<void> {
        return this._onDidChangeCodeLenses.event;
    }

    static selector: DocumentSelector = { scheme: DocumentSchemes.File };

    private _config: IConfig;
    private _documentIsDirty: boolean;

    constructor(context: ExtensionContext, private git: GitService) {
        this._config = workspace.getConfiguration().get<IConfig>(ExtensionKey)!;
    }

    reset() {
        this._config = workspace.getConfiguration().get<IConfig>(ExtensionKey)!;

        Logger.log('Triggering a reset of the git CodeLens provider');
        this._onDidChangeCodeLenses.fire();
    }

    async provideCodeLenses(document: TextDocument, token: CancellationToken): Promise<CodeLens[]> {
        this._documentIsDirty = document.isDirty;

        let languageLocations = this._config.codeLens.perLanguageLocations.find(_ => _.language !== undefined && _.language.toLowerCase() === document.languageId);
        if (languageLocations == null) {
            languageLocations = {
                language: undefined,
                locations: this._config.codeLens.locations,
                customSymbols: this._config.codeLens.customLocationSymbols
            } as ICodeLensLanguageLocation;
        }

        const lenses: CodeLens[] = [];

        const gitUri = await GitUri.fromUri(document.uri, this.git);

        const blamePromise = this.git.getBlameForFile(gitUri);
        let blame: GitBlame | undefined;
        if (languageLocations.locations.length === 1 && languageLocations.locations.includes(CodeLensLocations.Document)) {
            blame = await blamePromise;
            if (blame === undefined || blame.lines.length === 0) return lenses;
        }
        else {
            const values = await Promise.all([
                blamePromise as Promise<any>,
                commands.executeCommand(BuiltInCommands.ExecuteDocumentSymbolProvider, document.uri) as Promise<any>
            ]);

            blame = values[0] as GitBlame;
            if (blame === undefined || blame.lines.length === 0) return lenses;

            const symbols = values[1] as SymbolInformation[];
            Logger.log('GitCodeLensProvider.provideCodeLenses:', `${symbols.length} symbol(s) found`);
            symbols.forEach(sym => this._provideCodeLens(gitUri, document, sym, languageLocations!, blame!, lenses));
        }

        if (languageLocations.locations.includes(CodeLensLocations.Document) ||
            (languageLocations.locations.includes(CodeLensLocations.Custom) && (languageLocations.customSymbols || []).find(_ => _.toLowerCase() === 'file'))) {
            // Check if we have a lens for the whole document -- if not add one
            if (!lenses.find(l => l.range.start.line === 0 && l.range.end.line === 0)) {
                const blameRange = document.validateRange(new Range(0, 1000000, 1000000, 1000000));
                let blameForRangeFn: (() => GitBlameLines | undefined) | undefined = undefined;
                if (this._documentIsDirty || this._config.codeLens.recentChange.enabled) {
                    blameForRangeFn = Functions.once(() => this.git.getBlameForRangeSync(blame!, gitUri, blameRange));
                    lenses.push(new GitRecentChangeCodeLens(blameForRangeFn, gitUri, SymbolKind.File, blameRange, true, new Range(0, 0, 0, blameRange.start.character)));
                }
                if (this._config.codeLens.authors.enabled) {
                    if (blameForRangeFn === undefined) {
                        blameForRangeFn = Functions.once(() => this.git.getBlameForRangeSync(blame!, gitUri, blameRange));
                    }
                    if (!this._documentIsDirty) {
                        lenses.push(new GitAuthorsCodeLens(blameForRangeFn, gitUri, SymbolKind.File, blameRange, true, new Range(0, 1, 0, blameRange.start.character)));
                    }
                }
            }
        }

        return lenses;
    }

    private _validateSymbolAndGetBlameRange(document: TextDocument, symbol: SymbolInformation, languageLocation: ICodeLensLanguageLocation): Range | undefined {
        let valid = false;
        let range: Range | undefined;

        switch (symbol.kind) {
            case SymbolKind.File:
                if (languageLocation.locations.includes(CodeLensLocations.Containers)) {
                    valid = true;
                }
                else if (languageLocation.locations.includes(CodeLensLocations.Custom)) {
                    valid = !!(languageLocation.customSymbols || []).find(_ => _.toLowerCase() === SymbolKind[symbol.kind].toLowerCase());
                }

                if (valid) {
                    // Adjust the range to be for the whole file
                    range = document.validateRange(new Range(0, 1000000, 1000000, 1000000));
                }
                break;

            case SymbolKind.Package:
                if (languageLocation.locations.includes(CodeLensLocations.Containers)) {
                    valid = true;
                }
                else if (languageLocation.locations.includes(CodeLensLocations.Custom)) {
                    valid = !!(languageLocation.customSymbols || []).find(_ => _.toLowerCase() === SymbolKind[symbol.kind].toLowerCase());
                }

                if (valid) {
                    // Adjust the range to be for the whole file
                    if (symbol.location.range.start.line === 0 && symbol.location.range.end.line === 0) {
                        range = document.validateRange(new Range(0, 1000000, 1000000, 1000000));
                    }
                }
                break;

            case SymbolKind.Class:
            case SymbolKind.Interface:
            case SymbolKind.Module:
            case SymbolKind.Namespace:
            case SymbolKind.Struct:
                if (languageLocation.locations.includes(CodeLensLocations.Containers)) {
                    valid = true;
                }
                break;

            case SymbolKind.Constructor:
            case SymbolKind.Enum:
            case SymbolKind.Function:
            case SymbolKind.Method:
            case SymbolKind.Property:
                if (languageLocation.locations.includes(CodeLensLocations.Blocks)) {
                    valid = true;
                }
                break;
        }

        if (!valid && languageLocation.locations.includes(CodeLensLocations.Custom)) {
            valid = !!(languageLocation.customSymbols || []).find(_ => _.toLowerCase() === SymbolKind[symbol.kind].toLowerCase());
        }

        return valid ? range || symbol.location.range : undefined;
    }

    private _provideCodeLens(gitUri: GitUri, document: TextDocument, symbol: SymbolInformation, languageLocation: ICodeLensLanguageLocation, blame: GitBlame, lenses: CodeLens[]): void {
        const blameRange = this._validateSymbolAndGetBlameRange(document, symbol, languageLocation);
        if (!blameRange) return;

        const line = document.lineAt(symbol.location.range.start);
        // Make sure there is only 1 lens per line
        if (lenses.length && lenses[lenses.length - 1].range.start.line === line.lineNumber) return;

        // Anchor the code lens to the end of the line -- so they are somewhat consistently placed
        let startChar = line.range.end.character - 1;

        let blameForRangeFn: (() => GitBlameLines | undefined) | undefined = undefined;
        if (this._documentIsDirty || this._config.codeLens.recentChange.enabled) {
            blameForRangeFn = Functions.once(() => this.git.getBlameForRangeSync(blame, gitUri, blameRange));
            lenses.push(new GitRecentChangeCodeLens(blameForRangeFn, gitUri, symbol.kind, blameRange, false, line.range.with(new Position(line.range.start.line, startChar))));
            startChar++;
        }

        if (this._config.codeLens.authors.enabled) {
            let multiline = !blameRange.isSingleLine;
            // HACK for Omnisharp, since it doesn't return full ranges
            if (!multiline && document.languageId === 'csharp') {
                switch (symbol.kind) {
                    case SymbolKind.File:
                        break;
                    case SymbolKind.Package:
                    case SymbolKind.Module:
                    case SymbolKind.Namespace:
                    case SymbolKind.Class:
                    case SymbolKind.Interface:
                    case SymbolKind.Constructor:
                    case SymbolKind.Method:
                    case SymbolKind.Function:
                    case SymbolKind.Enum:
                        multiline = true;
                        break;
                }
            }

            if (multiline) {
                if (blameForRangeFn === undefined) {
                    blameForRangeFn = Functions.once(() => this.git.getBlameForRangeSync(blame, gitUri, blameRange));
                }
                if (!this._documentIsDirty) {
                    lenses.push(new GitAuthorsCodeLens(blameForRangeFn, gitUri, symbol.kind, blameRange, false, line.range.with(new Position(line.range.start.line, startChar))));
                }
            }
        }
    }

    resolveCodeLens(lens: CodeLens, token: CancellationToken): CodeLens | Thenable<CodeLens> {
        if (lens instanceof GitRecentChangeCodeLens) return this._resolveGitRecentChangeCodeLens(lens, token);
        if (lens instanceof GitAuthorsCodeLens) return this._resolveGitAuthorsCodeLens(lens, token);
        return Promise.reject<CodeLens>(undefined);
    }

    _resolveGitRecentChangeCodeLens(lens: GitRecentChangeCodeLens, token: CancellationToken): CodeLens {
        // Since blame information isn't valid when there are unsaved changes -- update the lenses appropriately
        let title: string;
        if (this._documentIsDirty) {
            if (this._config.codeLens.recentChange.enabled && this._config.codeLens.authors.enabled) {
                title = this._config.strings.codeLens.unsavedChanges.recentChangeAndAuthors;
            }
            else if (this._config.codeLens.recentChange.enabled) {
                title = this._config.strings.codeLens.unsavedChanges.recentChangeOnly;
            }
            else {
                title = this._config.strings.codeLens.unsavedChanges.authorsOnly;
            }

            lens.command = { title: title } as Command;
            return lens;
        }

        const blame = lens.getBlame();
        if (blame === undefined) return lens;

        const recentCommit = Iterables.first(blame.commits.values());
        title = `${recentCommit.author}, ${recentCommit.fromNow()}`;
        if (this._config.codeLens.debug) {
            title += ` [${SymbolKind[lens.symbolKind]}(${lens.range.start.character}-${lens.range.end.character}), Lines (${lens.blameRange.start.line + 1}-${lens.blameRange.end.line + 1}), Commit (${recentCommit.shortSha})]`;
        }

        switch (this._config.codeLens.recentChange.command) {
            case CodeLensCommand.BlameAnnotate: return this._applyBlameAnnotateCommand<GitRecentChangeCodeLens>(title, lens, blame);
            case CodeLensCommand.ShowBlameHistory: return this._applyShowBlameHistoryCommand<GitRecentChangeCodeLens>(title, lens, blame, recentCommit);
            case CodeLensCommand.ShowFileHistory: return this._applyShowFileHistoryCommand<GitRecentChangeCodeLens>(title, lens, blame, recentCommit);
            case CodeLensCommand.DiffWithPrevious: return this._applyDiffWithPreviousCommand<GitRecentChangeCodeLens>(title, lens, blame, recentCommit);
            case CodeLensCommand.ShowQuickCommitDetails: return this._applyShowQuickCommitDetailsCommand<GitRecentChangeCodeLens>(title, lens, blame, recentCommit);
            case CodeLensCommand.ShowQuickCommitFileDetails: return this._applyShowQuickCommitFileDetailsCommand<GitRecentChangeCodeLens>(title, lens, blame, recentCommit);
            case CodeLensCommand.ShowQuickFileHistory: return this._applyShowQuickFileHistoryCommand<GitRecentChangeCodeLens>(title, lens, blame, recentCommit);
            case CodeLensCommand.ShowQuickCurrentBranchHistory: return this._applyShowQuickBranchHistoryCommand<GitRecentChangeCodeLens>(title, lens, blame, recentCommit);
            default: return lens;
        }
    }

    _resolveGitAuthorsCodeLens(lens: GitAuthorsCodeLens, token: CancellationToken): CodeLens {
        const blame = lens.getBlame();
        if (blame === undefined) return lens;

        const count = blame.authors.size;
        let title = `${count} ${count > 1 ? 'authors' : 'author'} (${Iterables.first(blame.authors.values()).name}${count > 1 ? ' and others' : ''})`;
        if (this._config.codeLens.debug) {
            title += ` [${SymbolKind[lens.symbolKind]}(${lens.range.start.character}-${lens.range.end.character}), Lines (${lens.blameRange.start.line + 1}-${lens.blameRange.end.line + 1}), Authors (${Iterables.join(Iterables.map(blame.authors.values(), _ => _.name), ', ')})]`;
        }

        switch (this._config.codeLens.authors.command) {
            case CodeLensCommand.BlameAnnotate: return this._applyBlameAnnotateCommand<GitAuthorsCodeLens>(title, lens, blame);
            case CodeLensCommand.ShowBlameHistory: return this._applyShowBlameHistoryCommand<GitAuthorsCodeLens>(title, lens, blame);
            case CodeLensCommand.ShowFileHistory: return this._applyShowFileHistoryCommand<GitAuthorsCodeLens>(title, lens, blame);
            case CodeLensCommand.DiffWithPrevious: return this._applyDiffWithPreviousCommand<GitAuthorsCodeLens>(title, lens, blame);
            case CodeLensCommand.ShowQuickCommitDetails: return this._applyShowQuickCommitDetailsCommand<GitAuthorsCodeLens>(title, lens, blame);
            case CodeLensCommand.ShowQuickCommitFileDetails: return this._applyShowQuickCommitFileDetailsCommand<GitAuthorsCodeLens>(title, lens, blame);
            case CodeLensCommand.ShowQuickFileHistory: return this._applyShowQuickFileHistoryCommand<GitAuthorsCodeLens>(title, lens, blame);
            case CodeLensCommand.ShowQuickCurrentBranchHistory: return this._applyShowQuickBranchHistoryCommand<GitAuthorsCodeLens>(title, lens, blame);
            default: return lens;
        }
    }

    _applyBlameAnnotateCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(title: string, lens: T, blame: GitBlameLines): T {
        lens.command = {
            title: title,
            command: Commands.ToggleFileBlame,
            arguments: [Uri.file(lens.uri.fsPath)]
        };
        return lens;
    }

    _applyShowBlameHistoryCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(title: string, lens: T, blame: GitBlameLines, commit?: GitBlameCommit): T {
        let line = lens.range.start.line;
        if (commit) {
            const blameLine = commit.lines.find(_ => _.line === line);
            if (blameLine) {
                line = blameLine.originalLine;
            }
        }

        const position = lens.isFullRange ? new Position(1, 0) : lens.range.start;
        lens.command = {
            title: title,
            command: Commands.ShowBlameHistory,
            arguments: [
                Uri.file(lens.uri.fsPath),
                {
                    line,
                    position,
                    range: lens.blameRange,
                    sha: commit && commit.sha
                } as ShowBlameHistoryCommandArgs
            ]
        };
        return lens;
    }

    _applyShowFileHistoryCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(title: string, lens: T, blame: GitBlameLines, commit?: GitBlameCommit): T {
        let line = lens.range.start.line;
        if (commit) {
            const blameLine = commit.lines.find(_ => _.line === line);
            if (blameLine) {
                line = blameLine.originalLine;
            }
        }

        const position = lens.isFullRange ? new Position(1, 0) : lens.range.start;
        lens.command = {
            title: title,
            command: Commands.ShowFileHistory,
            arguments: [
                Uri.file(lens.uri.fsPath),
                {
                    line,
                    position,
                    sha: commit && commit.sha
                } as ShowFileHistoryCommandArgs
            ]
        };
        return lens;
    }

    _applyDiffWithPreviousCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(title: string, lens: T, blame: GitBlameLines, commit?: GitBlameCommit): T {
        if (commit === undefined) {
            const blameLine = blame.allLines[lens.range.start.line];
            commit = blame.commits.get(blameLine.sha);
        }

        lens.command = {
            title: title,
            command: Commands.DiffWithPrevious,
            arguments: [
                Uri.file(lens.uri.fsPath),
                {
                    commit: commit,
                    range: lens.isFullRange ? undefined : lens.blameRange
                } as DiffWithPreviousCommandArgs
            ]
        };
        return lens;
    }

    _applyShowQuickCommitDetailsCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(title: string, lens: T, blame: GitBlameLines, commit?: GitBlameCommit): T {
        lens.command = {
            title: title,
            command: commit !== undefined && commit.isUncommitted ? '' : CodeLensCommand.ShowQuickCommitDetails,
            arguments: [
                Uri.file(lens.uri.fsPath),
                {
                    commit,
                    sha: commit === undefined ? undefined : commit.sha
                } as ShowQuickCommitDetailsCommandArgs]
        };
        return lens;
    }

    _applyShowQuickCommitFileDetailsCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(title: string, lens: T, blame: GitBlameLines, commit?: GitBlameCommit): T {
        lens.command = {
            title: title,
            command: commit !== undefined && commit.isUncommitted ? '' : CodeLensCommand.ShowQuickCommitFileDetails,
            arguments: [
                Uri.file(lens.uri.fsPath),
                {
                    commit,
                    sha: commit === undefined ? undefined : commit.sha
                } as ShowQuickCommitFileDetailsCommandArgs]
        };
        return lens;
    }

    _applyShowQuickFileHistoryCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(title: string, lens: T, blame: GitBlameLines, commit?: GitBlameCommit): T {
        lens.command = {
            title: title,
            command: CodeLensCommand.ShowQuickFileHistory,
            arguments: [
                Uri.file(lens.uri.fsPath),
                {
                    range: lens.isFullRange ? undefined : lens.blameRange
                } as ShowQuickFileHistoryCommandArgs
            ]
        };
        return lens;
    }

    _applyShowQuickBranchHistoryCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(title: string, lens: T, blame: GitBlameLines, commit?: GitBlameCommit): T {
        lens.command = {
            title: title,
            command: CodeLensCommand.ShowQuickCurrentBranchHistory,
            arguments: [Uri.file(lens.uri.fsPath)]
        };
        return lens;
    }
}