// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    Disposable,
    Uri,
    OutputChannel as VscOutputChannel,
    window,
    workspace,
} from "vscode";
import * as path from "path";
export function logAndDisplayError(ex: Error | any) {
    window.showErrorMessage(ex.message || ex.toString());
    OutputChannel.instance?.appendLine(`[Error]:${ex.toString()}`);
}

function disposeAllDisposables(disposables: Disposable[]) {
    while (disposables.length) {
        const item = disposables.pop();
        if (item) {
            try {
                item.dispose();
            } catch {
                //
            }
        }
    }
}
export class Disposables extends Disposable {
    private readonly disposables: Disposable[] = [];
    constructor() {
        super(() => disposeAllDisposables(this.disposables));
    }
    public push(disposable: Disposable) {
        this.disposables.push(disposable);
    }
}

export const OutputChannel: {
    instance?: VscOutputChannel;
} = {
    instance: undefined,
};

const HOME_DIR = require("os").homedir();
export function getDisplayPath(
    file: Uri | string | undefined,
    cwd?: Uri | string
): string {
    if (!file) {
        return "";
    }
    file = file instanceof Uri ? file : Uri.file(file);
    cwd = (!cwd || cwd instanceof Uri ? cwd : Uri.file(cwd)) as Uri | undefined;
    if (
        !cwd &&
        workspace.workspaceFolders &&
        workspace.workspaceFolders.length > 0
    ) {
        cwd = workspace.workspaceFolders[0].uri;
    }
    const isWindows = process.platform === "win32";
    if (file && cwd && file.fsPath == cwd.fsPath) {
        return path.basename(file.fsPath);
    }
    if (file && cwd && file.fsPath.startsWith(cwd.fsPath)) {
        return file.fsPath.replace(cwd.fsPath, ".");
    }

    if (file && file.fsPath.startsWith(HOME_DIR)) {
        return file.fsPath.replace(HOME_DIR, "~");
    }

    return file.fsPath;
}
