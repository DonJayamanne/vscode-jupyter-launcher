// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as vscode from "vscode";
import { JupyterType, launchJupyter } from "./jupyterLauncher";
import { OutputChannel } from "./helpers";
import {
    addJupyterServer,
    registerProvider,
    restoreJupyterServers,
    shutdownJupyterServer,
} from "./jupyterIntegration";


export function activate(context: vscode.ExtensionContext) {
    OutputChannel.instance =
        vscode.window.createOutputChannel("Jupyter Launcher");
    context.subscriptions.push(OutputChannel.instance);
    context.subscriptions.push(registerProvider(context.workspaceState));
    restoreJupyterServers(context.workspaceState);
    vscode.window.onDidChangeTerminalState(
        () => restoreJupyterServers(context.workspaceState),
        undefined,
        context.subscriptions
    );
    vscode.window.onDidChangeActiveTerminal(
        () => restoreJupyterServers(context.workspaceState),
        undefined,
        context.subscriptions
    );
    vscode.window.onDidCloseTerminal(
        (t) => shutdownJupyterServer(t),
        undefined,
        context.subscriptions
    );
    const startJupyterServer = async (type: JupyterType) => {
        const serverInfo = await launchJupyter({
            type,
            customize: true,
            displayOptionToIntegrateWithJupyter: true,
        }).catch(logAndDisplayError);
        if (serverInfo?.registerWithJupyterExtension) {
            context.subscriptions.push(serverInfo);
            addJupyterServer(context.workspaceState, serverInfo);
        }
    };
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "vscode-jupyter-launcher.launch-notebook",
            () => startJupyterServer("Jupyter Notebook")
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "vscode-jupyter-launcher.launch-lab",
            () => startJupyterServer("Jupyter Lab")
        )
    );
}

// This method is called when your extension is deactivated
export function deactivate() {}
function logAndDisplayError(reason: any): PromiseLike<never> {
    throw new Error("Function not implemented.");
}

