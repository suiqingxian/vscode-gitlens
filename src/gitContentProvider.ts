'use strict';
import { CancellationToken, ExtensionContext, TextDocumentContentProvider, Uri, window } from 'vscode';
import { DocumentSchemes } from './constants';
import { GitService } from './gitService';
import { Logger } from './logger';
import * as path from 'path';

export class GitContentProvider implements TextDocumentContentProvider {

    static scheme = DocumentSchemes.GitLensGit;

    constructor(context: ExtensionContext, private git: GitService) { }

    async provideTextDocumentContent(uri: Uri, token: CancellationToken): Promise<string | undefined> {
        const data = GitService.fromGitContentUri(uri);
        const fileName = data.originalFileName || data.fileName;
        try {
            let text = data.sha !== GitService.fakeSha
                ? await this.git.getVersionedFileText(data.repoPath, fileName, data.sha)
                : '';
            if (data.decoration) {
                text = `${data.decoration}\n${text}`;
            }
            return text;
        }
        catch (ex) {
            Logger.error(ex, 'GitContentProvider', 'getVersionedFileText');
            window.showErrorMessage(`Unable to show Git revision ${GitService.shortenSha(data.sha)} of '${path.relative(data.repoPath, fileName)}'`);
            return undefined;
        }
    }
}