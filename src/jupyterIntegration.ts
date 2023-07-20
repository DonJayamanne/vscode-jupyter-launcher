// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    CancellationError,
    Disposable,
    Memento,
    QuickInputButtons,
    QuickPickItemKind,
    Terminal,
    Uri,
    window,
} from "vscode";
import {
    JupyterServerCollection,
    JupyterServerConnectionInformation,
} from "./jupyter";
import { OutputChannel } from "./helpers";
import { JupyterServer, launchJupyter } from "./jupyterLauncher";

type IJupyterServerUri = JupyterServerConnectionInformation & {
    label: string;
    pid: number;
};
const servers = new Map<
    string,
    {
        serverUri: IJupyterServerUri;
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
            disposables: Disposable[];
        }[]
    ).forEach((server) => {
        if (!server?.serverUri?.pid) {
            return;
        }
        if (servers.has(server.serverUri.pid.toString())) {
            return;
        }
        const terminal = terminalsByPid.get(server.serverUri.pid);
        if (!terminal) {
            return;
        }
        const vscServer = collection.createServer(
            server.serverUri.pid.toString(),
            server.serverUri.label,
            async () => server.serverUri
        );
        server.disposables = [terminal, vscServer];
        servers.set(server.serverUri.pid.toString(), server);
    });
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
        mappedRemoteNotebookDir: server.jupyterExtensionWorkingDirectory,
        authorizationHeader: undefined,
    };
    const vsCodeServer = collection.createServer(
        server.pid.toString(),
        `Jupyter Notebook at ${server.baseUrl}`,
        async () => jupyterServer
    );
    const details = {
        serverUri: jupyterServer,
        disposables: [server, vsCodeServer],
    };

    storeJupyterServers(memento, details);

    servers.set(server.pid.toString(), details);
    return vsCodeServer;
}
export function registerProvider(
    collection: JupyterServerCollection,
    memento: Memento
) {
    collection.createServerCreationItem(
        "Start New Jupyter Notebook Server",
        () => startJupyterServer("Jupyter Notebook", collection, memento)
    );
    collection.createServerCreationItem("Start New Jupyter Lab Server", () =>
        startJupyterServer("Jupyter Lab", collection, memento)
    );
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
        return addJupyterServer(collection, memento, server);
    } catch (ex) {
        OutputChannel.instance?.appendLine(
            `[Error]: Failed to start ${type}, ${ex}`
        );
    } finally {
        quickPick.hide();
        quickPick.dispose();
    }
}
