// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    CancellationError,
    Disposable,
    EventEmitter,
    Memento,
    QuickInputButtons,
    QuickPickItemKind,
    Terminal,
    Uri,
    commands,
    window,
} from "vscode";
import {
    JupyterServer as JupyterServerAPIType,
    JupyterServerCollection,
    JupyterServerConnectionInformation,
} from "./jupyter";
import { OutputChannel } from "./helpers";
import { JupyterServer, launchJupyter } from "./jupyterLauncher";

type IJupyterServerUri = JupyterServerConnectionInformation & {
    label: string;
    pid: number;
};
const onDidChangeServers = new EventEmitter<void>();
const servers = new Map<
    string,
    {
        serverUri: IJupyterServerUri;
        server: JupyterServer;
        disposables: Disposable[];
    }
>();

export async function shutdownJupyterServer(terminal: Terminal) {
    const pid = await terminal.processId;
    if (!pid) {
        return;
    }
    const server = servers.get(pid.toString());
    if (!server) {
        return;
    }
    server.disposables.forEach((d) => {
        try {
            d.dispose();
        } catch {}
    });
    servers.delete(pid.toString());
}

export async function restoreJupyterServers(
    collection: JupyterServerCollection,
    memento: Memento
) {
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

    (
        memento.get("jupyterServers", []) as {
            serverUri: IJupyterServerUri & Disposable;
            server: JupyterServer;
            disposables: Disposable[];
        }[]
    ).forEach((server) => {
        if (!server?.serverUri?.pid) {
            return;
        }
        if (server.serverUri.baseUrl) {
            (server.serverUri as any).baseUrl = Uri.parse(
                server.serverUri.baseUrl as any
            );
        }
        if (servers.has(server.serverUri.pid.toString())) {
            return;
        }
        const terminal = terminalsByPid.get(server.serverUri.pid);
        if (!terminal) {
            return;
        }
        server.server = {
            cwd: "",
            dispose: () => {
                /** */
            },
            password: "",
            pid: server.serverUri.pid,
            port: parseInt(new URL(server.serverUri.baseUrl.toString()).port),
            registerWithJupyterExtension: true,
            shellArgs: [],
            type: server.serverUri.label.startsWith("Jupyter Notebook")
                ? "Jupyter Notebook"
                : "Jupyter Lab",
            baseUrl: server.serverUri.baseUrl.toString(),
            token: server.serverUri.token,
            jupyterExtensionWorkingDirectory:
                server.serverUri.mappedRemoteNotebookDir?.toString(),
        };
        server.disposables = [terminal];
        servers.set(server.serverUri.pid.toString(), server);
    });
    onDidChangeServers.fire();
}
async function storeJupyterServers(
    memento: Memento,
    server: {
        serverUri: IJupyterServerUri;
        disposables: Disposable[];
    }
) {
    const servers = memento.get("jupyterServers", []) as {
        serverUri: IJupyterServerUri;
        disposables: Disposable[];
    }[];
    servers.push(server);
    // Don't attempt to store disposables.
    await memento.update(
        "jupyterServers",
        servers.map((s) => ({ ...s, disposables: [] }))
    );
}
export function addJupyterServer(
    collection: JupyterServerCollection,
    memento: Memento,
    server: JupyterServer
) {
    if (servers.has(server.pid.toString())) {
        OutputChannel.instance?.appendLine(
            `[Warning]: Jupyter server already started for this workspace with pid ${server.pid}.`
        );
        return;
    }
    const jupyterServer: IJupyterServerUri = {
        pid: server.pid,
        baseUrl: Uri.parse(server.baseUrl),
        token: server.token,
        label: `${server.type} ${server.baseUrl}`,
        mappedRemoteNotebookDir: server.jupyterExtensionWorkingDirectory
            ? Uri.file(server.jupyterExtensionWorkingDirectory)
            : undefined,
        authorizationHeader: undefined,
    };
    const details = {
        serverUri: jupyterServer,
        server,
        disposables: [server],
    };

    storeJupyterServers(memento, details);

    servers.set(server.pid.toString(), details);
    onDidChangeServers.fire();
}
export function registerProvider(
    collection: JupyterServerCollection,
    memento: Memento
) {
    const serverToApiMapping = new Map<JupyterServer, JupyterServerAPIType>();
    const _onDidChangeServers = new EventEmitter<void>();
    onDidChangeServers.event(() => _onDidChangeServers.fire());
    collection.serverProvider = {
        onDidChangeServers: _onDidChangeServers.event,
        getJupyterServers: async (token) => {
            debugger;
            const existingProcessIds = Array.from(
                serverToApiMapping.keys()
            ).map((s) => s.pid.toString());
            servers.forEach(({ serverUri, server }, pid) => {
                if (existingProcessIds.includes(pid)) {
                    return;
                }
                const notebookOrLab = serverUri.label.startsWith(
                    "Jupyter Notebook"
                )
                    ? "Jupyter Notebook"
                    : "Jupyter Lab";
                const apiType: JupyterServerAPIType = {
                    id: serverUri.pid.toString(),
                    label: `${notebookOrLab} at ${serverUri.baseUrl}`,
                    resolveConnectionInformation: async () => {
                        return {
                            baseUrl: serverUri.baseUrl,
                            token: serverUri.token,
                            mappedRemoteNotebookDir:
                                serverUri.mappedRemoteNotebookDir,
                        };
                    },
                };
                serverToApiMapping.set(server, apiType);
            });
            return Array.from(serverToApiMapping.values());
        },
    };
    commands.registerCommand(
        "jupyter.notebookLauncher",
        async (notebookOrLab: "Jupyter Notebook" | "Jupyter Lab") => {
            debugger;
            const server = await startJupyterServer(
                notebookOrLab,
                collection,
                memento
            );
            if (!server) {
                return;
            }
            const apiType: JupyterServerAPIType = {
                id: server.pid.toString(),
                label: `${notebookOrLab} at ${server.baseUrl}`,
                resolveConnectionInformation: async () => {
                    return {
                        baseUrl: Uri.parse(server.baseUrl),
                        token: server.token,
                        mappedRemoteNotebookDir:
                            server.jupyterExtensionWorkingDirectory
                                ? Uri.file(
                                      server.jupyterExtensionWorkingDirectory
                                  )
                                : undefined,
                    };
                },
            };
            debugger;
            serverToApiMapping.set(server, apiType);
            _onDidChangeServers.fire();
            return apiType;
        }
    );
    collection.commandProvider = {
        getCommands: async (token) => {
            return [
                {
                    command: "jupyter.launcher",
                    title: "Start New Jupyter Notebook Server",
                    arguments: ["Jupyter Notebook"],
                },
                {
                    command: "jupyter.launcher",
                    title: "Start New Jupyter Lab Server",
                    arguments: ["Jupyter Lab"],
                },
            ];
        },
    };
}

async function startJupyterServer(
    type: "Jupyter Lab" | "Jupyter Notebook",
    collection: JupyterServerCollection,
    memento: Memento
) {
    const quickPick = window.createQuickPick();
    quickPick.title = "Starting Jupyter Notebook";
    const showProgress = () => {
        quickPick.enabled = false;
        quickPick.busy = true;
        quickPick.show();
    };
    showProgress();
    try {
        const server = await launchJupyter({
            type,
            customize: true,
            displayOptionToIntegrateWithJupyter: false,
            showProgress,
        });
        if (!server) {
            throw new CancellationError();
        }
        addJupyterServer(collection, memento, server);
        return server;
    } catch (ex) {
        OutputChannel.instance?.appendLine(
            `[Error]: Failed to start ${type}, ${ex}`
        );
    } finally {
        quickPick.hide();
        quickPick.dispose();
    }
}
