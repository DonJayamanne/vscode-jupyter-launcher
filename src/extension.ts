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
import { JupyterAPI } from "./jupyter";

export async function activate(context: vscode.ExtensionContext) {
    const api =
        vscode.extensions.getExtension<JupyterAPI>(
            "ms-toolsai.jupyter"
        )?.exports;
    if (!api) {
        throw new Error("Jupyter extension not found");
    }
    const collection = await api.createJupyterServerCollection(
        "jupyterLauncher",
        "Local Jupyter Server"
    );

    OutputChannel.instance =
        vscode.window.createOutputChannel("Jupyter Launcher");
    context.subscriptions.push(OutputChannel.instance);
    registerProvider(collection, context.workspaceState);
    restoreJupyterServers(collection, context.workspaceState);
    vscode.window.onDidChangeTerminalState(
        () => restoreJupyterServers(collection, context.workspaceState),
        undefined,
        context.subscriptions
    );
    vscode.window.onDidChangeActiveTerminal(
        () => restoreJupyterServers(collection, context.workspaceState),
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
            addJupyterServer(collection, context.workspaceState, serverInfo);
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
