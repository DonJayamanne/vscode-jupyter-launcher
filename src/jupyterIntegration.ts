// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    Disposable,
    EventEmitter,
    Memento,
    QuickPickItem,
    Terminal,
    extensions,
    window,
} from "vscode";
import {
    IJupyterServerUri,
    IJupyterUriProvider,
    JupyterAPI,
    JupyterServerUriHandle,
} from "./jupyter";
import { OutputChannel } from "./helpers";
import { JupyterServer, launchJupyter } from "./jupyterLauncher";

const servers = new Map<
    number,
    { serverUri: IJupyterServerUri & Disposable; serverInfo: JupyterServer }
>();
const onDidChangeHandles = new EventEmitter<void>();
let registered = false;

export async function shutdownJupyterServer(terminal: Terminal) {
    const pid = await terminal.processId;
    if (!pid) {
        return;
    }
    const server = servers.get(pid);
    if (!server) {
        return;
    }
    server.serverInfo.dispose();
    servers.delete(pid);
    onDidChangeHandles.fire();
}

export async function restoreJupyterServers(memento: Memento) {
    const terminalsByPid = new Map<number, Terminal>();
    await Promise.all(
        window.terminals.map(async (t) => {
            if (
                !t.name.startsWith("Jupyter Notebook at") &&
                !t.name.startsWith("Jupyter Lab at")
            ) {
                return;
            }
            const pid = await t.processId;
            if (!pid) {
                return;
            }
            if (terminalsByPid.get(pid) !== t) {
                terminalsByPid.set(pid, t);
            }
        })
    );

    let updated = false;
    (
        memento.get("jupyterServers", []) as {
            serverUri: IJupyterServerUri & Disposable;
            serverInfo: JupyterServer;
        }[]
    ).forEach((server) => {
        if (
            !server?.serverInfo?.pid ||
            !server?.serverUri ||
            (!terminalsByPid.has(server.serverInfo.pid) &&
                !servers.has(server.serverInfo.pid))
        ) {
            return;
        }
        server.serverInfo.dispose = () =>
            terminalsByPid.get(server.serverInfo.pid)?.dispose();
        servers.set(server.serverInfo.pid, server);
    });

    if (updated) {
        onDidChangeHandles.fire();
    }
}
async function storeJupyterServers(
    memento: Memento,
    server: {
        serverUri: IJupyterServerUri & Disposable;
        serverInfo: JupyterServer;
    }
) {
    const servers = memento.get("jupyterServers", []) as {
        serverUri: IJupyterServerUri & Disposable;
        serverInfo: JupyterServer;
    }[];
    servers.push(server);
    await memento.update("jupyterServers", servers);
}
export function addJupyterServer(memento: Memento, server: JupyterServer) {
    if (servers.has(server.pid)) {
        OutputChannel.instance?.appendLine(
            `[Warning]: Jupyter server already started for this workspace with information ${server.pid}.`
        );
        return;
    }
    const jupyterServer: IJupyterServerUri = {
        baseUrl: server.baseUrl,
        token: server.token,
        displayName: `${server.type} ${server.baseUrl}`,
        mappedRemoteNotebookDir: server.jupyterExtensionWorkingDirectory,
        authorizationHeader: undefined,
    };
    const details = {
        serverInfo: server,
        serverUri: {
            ...jupyterServer,
            dispose: () => server.dispose(),
        },
    };

    storeJupyterServers(memento, details);
    servers.set(server.pid, details);

    onDidChangeHandles.fire();
}
export function registerProvider(memento: Memento) {
    if (registered) {
        return {
            dispose: () => {
                //
            },
        };
    }
    registered = true;
    const uriProvider: IJupyterUriProvider = {
        id: "jupyterLauncher",
        getServerUri: function (handle: string): Promise<IJupyterServerUri> {
            if (!servers.has(parseInt(handle, 10))) {
                throw new Error("Invalid handle");
            }
            return Promise.resolve(
                servers.get(parseInt(handle, 10))!.serverUri
            );
        },
        displayName: "Local Jupyter Server",
        getHandles: () => {
            return Promise.resolve(
                Array.from(servers.keys()).map((k) => k.toString())
            );
        },
        onDidChangeHandles: onDidChangeHandles.event,
        getQuickPickEntryItems: async () => {
            return [
                <QuickPickItem>{
                    label: "Start New Jupyter Notebook Server",
                },
                <QuickPickItem>{
                    label: "Start New Jupyter Lab Server",
                },
            ];
        },
        handleQuickPick: async (
            item: QuickPickItem & { default?: boolean },
            backEnabled
        ) => {
            if (!item) {
                return;
            }
            const quickPick = window.createQuickPick();
            quickPick.title = "Starting Jupyter Notebook";
            const showProgress = () => {
                quickPick.enabled = false;
                quickPick.busy = true;
                quickPick.show();
            };
            showProgress();
            try {
                if (
                    item.label === "Start New Jupyter Notebook Server" &&
                    item.default
                ) {
                    const server = await launchJupyter({
                        type: "Jupyter Notebook",
                        displayOptionToIntegrateWithJupyter: false,
                        showProgress,
                    });
                    quickPick.hide();
                    if (server) {
                        addJupyterServer(memento, server);
                        return server.pid.toString();
                    }
                } else if (item.label === "Start New Jupyter Notebook Server") {
                    const server = await launchJupyter({
                        type: "Jupyter Notebook",
                        customize: true,
                        canGoBack: backEnabled,
                        displayOptionToIntegrateWithJupyter: false,
                        showProgress,
                    });
                    if (server) {
                        addJupyterServer(memento, server);
                        return server.pid.toString();
                    }
                } else if (item.label === "Start New Jupyter Lab Server") {
                    const server = await launchJupyter({
                        type: "Jupyter Lab",
                        customize: true,
                        canGoBack: backEnabled,
                        displayOptionToIntegrateWithJupyter: false,
                        showProgress,
                    });
                    if (server) {
                        addJupyterServer(memento, server);
                        return server.pid.toString();
                    }
                }
            } catch (ex) {
                logAndDisplayError(ex);
            } finally {
                quickPick.hide();
                quickPick.dispose();
            }
        },
        removeHandle: async (handle: JupyterServerUriHandle) => {
            servers.get(parseInt(handle, 10))?.serverInfo?.dispose();
            servers.delete(parseInt(handle, 10));
            onDidChangeHandles.fire();
        },
    };

    const api =
        extensions.getExtension<JupyterAPI>("ms-toolsai.jupyter")?.exports;
    if (!api) {
        throw new Error("Jupyter extension not found");
    }
    api.registerRemoteServerProvider(uriProvider);
    return onDidChangeHandles;
}
function logAndDisplayError(reason: any): PromiseLike<never> {
    throw new Error("Function not implemented.");
}
