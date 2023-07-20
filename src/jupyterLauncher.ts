// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import {
    CancellationToken,
    ProgressLocation,
    QuickInputButtons,
    QuickPickItem,
    extensions,
    window,
    workspace,
} from "vscode";
import { IExtensionApi } from "./python";
import * as getPorts from "portfinder";
import { OutputChannel, getDisplayPath, logAndDisplayError } from "./helpers";

export type JupyterType = "Jupyter Notebook" | "Jupyter Lab";
export type JupyterServer = {
    shellArgs: string[];
    token: string;
    port: number;
    password: string;
    registerWithJupyterExtension: boolean;
    dispose: () => void;
    pid: number;
    type: JupyterType;
    baseUrl: string;
    cwd: string;
    jupyterExtensionWorkingDirectory?: string;
};

export async function launchJupyter(options: {
    type: JupyterType;
    token?: CancellationToken;
    customize?: boolean;
    canGoBack?: boolean;
    displayOptionToIntegrateWithJupyter?: boolean;
    showProgress?: () => void;
}): Promise<JupyterServer | undefined> {
    const pythonExt =
        extensions.getExtension<IExtensionApi>("ms-python.python")?.exports;
    if (options.showProgress) {
        options.showProgress();
    }
    const launchInfo = await getLaunchArgs(options);
    if (!launchInfo) {
        return;
    }
    return window.withProgress<JupyterServer | undefined>(
        { location: ProgressLocation.Notification, title: "Starting Jupyter" },
        async (progress) => {
            if (options.showProgress) {
                options.showProgress();
            }
            if (!pythonExt) {
                throw new Error("Python extension not found");
            }
            const activeInterpreter =
                pythonExt.environments.getActiveEnvironmentPath();
            const resolvedEnv = await pythonExt.environments.resolveEnvironment(
                activeInterpreter
            );
            if (options.token?.isCancellationRequested) {
                return;
            }
            if (!resolvedEnv || !resolvedEnv?.executable?.uri) {
                throw new Error("Python environment not found");
            }
            if (
                resolvedEnv.environment?.type &&
                resolvedEnv.environment.type !== "VirtualEnvironment"
            ) {
                throw new Error(
                    `Selected Python environment (${
                        resolvedEnv.environment.name ||
                        resolvedEnv.executable.uri.fsPath ||
                        resolvedEnv.executable.sysPrefix
                    }) is not a virtual env`
                );
            }
            progress.report({ message: "Resolving Python Environment" });
            const { shellArgs, port, token } = launchInfo;
            const shellPath = resolvedEnv.executable.uri.fsPath;
            OutputChannel.instance?.appendLine(
                `Starting Jupyter with ${shellPath} ${shellArgs.join(" ")}`
            );
            const baseUrl = `http://localhost:${port}/`;
            const url = `http://localhost:${port}/?token=${token}`;
            const pythonEnv = { ...process.env };
            if (pythonEnv.PATH) {
                pythonEnv.PATH = `${path.dirname(
                    resolvedEnv.executable.uri.fsPath
                )}${path.delimiter}${resolvedEnv.executable.sysPrefix}${
                    path.delimiter
                }${pythonEnv.PATH}`;
            }
            if (pythonEnv.Path) {
                pythonEnv.Path = `${path.dirname(
                    resolvedEnv.executable.uri.fsPath
                )}${path.delimiter}${resolvedEnv.executable.sysPrefix}${
                    path.delimiter
                }${pythonEnv.Path}`;
            }
            progress.report({ message: "Creating terminal..." });
            const terminal = window.createTerminal({
                name: `${options.type ?? "Jupyter Notebook"} at ${port}`,
                shellPath,
                shellArgs,
                cwd: launchInfo.cwd,
                env: pythonEnv,
                hideFromUser: false,
                isTransient: false,
                message: `Starting Jupyter with ${shellPath} ${shellArgs.join(
                    " "
                )}`,
            });

            try {
                OutputChannel.instance?.appendLine(`Jupyter Started at ${url}`);
                progress.report({ message: "Waiting for server..." });
                // Hack, wait for Jupyter server to start and respond to http requests.
                // We can try to ping and wait, however thats more code that will complicate this simple extension.
                await new Promise((resolve) => setTimeout(resolve, 5_000));
                progress.report({ message: "Waiting for terminal process..." });
                const pid = await terminal.processId;
                if (!pid) {
                    throw new Error("Failed to get PID");
                }
                return {
                    ...launchInfo,
                    dispose: () => terminal.dispose(),
                    port,
                    pid,
                    type: options.type,
                    baseUrl,
                    token,
                };
            } catch (ex) {
                logAndDisplayError(ex);
                terminal.dispose();
            }
        }
    );
}

async function getLaunchArgs(options: {
    type: JupyterType;
    token?: CancellationToken;
    customize?: boolean;
    canGoBack?: boolean;
    displayOptionToIntegrateWithJupyter?: boolean;
}): Promise<
    | {
          shellArgs: string[];
          token: string;
          port: number;
          password: string;
          registerWithJupyterExtension: boolean;
          cwd: string;
          jupyterExtensionWorkingDirectory?: string;
      }
    | undefined
> {
    let shouldOpenBrowser = false;
    let registerWithJupyterExtension = true;
    let cors = true;
    let workspaceFolder = workspace.workspaceFolders?.length
        ? workspace.workspaceFolders[0].uri.fsPath
        : undefined;
    const tmpDir = os.tmpdir();
    let cwd = workspaceFolder ?? tmpDir;
    let useCustomWorkingDirectory = false;
    let customCwd: string | undefined;
    let jupyterExtensionWorkingDirectory: string | undefined = cwd;
    const token = {
        value: "",
        isRandom: true,
        isEmpty: false,
    };
    let password = "";

    if (options.customize) {
        const randomToken = <QuickPickItem>{
            label: "Random Token",
            picked: true,
        };
        const emptyToken = <QuickPickItem>{
            label: "Empty Token",
            picked: false,
        };
        const passwordEnabled = <QuickPickItem>{
            label: "Password",
            picked: false,
        };
        const specificToken = <QuickPickItem>{
            label: "Specific Token",
            picked: false,
        };
        const localPathMapping = <QuickPickItem>{
            label: "Map local dir to remote notebook dir",
            picked: false,
        };
        const cwdPrompt = <QuickPickItem>{
            label: "Custom Working Directory",
            picked: false,
        };
        cwdPrompt.description =
            cwd === tmpDir ? "<Temporary Directory>" : getDisplayPath(cwd);
        localPathMapping.description =
            cwd === tmpDir ? "<Temporary Directory>" : getDisplayPath(cwd);

        // --NotebookApp.allow_origin
        const corsEnabled = <QuickPickItem>{
            label: "Allow access from other WebSites (bypass CORS)",
            picked: true,
        };
        const openInBrowser = <QuickPickItem>{
            label: "Open in browser",
            picked: false,
        };
        const registerWithJupyterExtensionPrompt = <QuickPickItem>{
            label: "Register with Jupyter Extension",
            picked: true,
        };
        if (options.displayOptionToIntegrateWithJupyter) {
            openInBrowser.picked = true;
        }
        const items: QuickPickItem[] = [
            passwordEnabled,
            // randomToken,
            emptyToken,
            specificToken,
            corsEnabled,
            openInBrowser,
            cwdPrompt,
            localPathMapping,
        ];
        if (options.displayOptionToIntegrateWithJupyter) {
            items.push(registerWithJupyterExtensionPrompt);
        }
        const quickPick = window.createQuickPick();
        if (options.canGoBack) {
            quickPick.buttons = [QuickInputButtons.Back];
        }
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        quickPick.canSelectMany = true;
        quickPick.items = items;
        quickPick.selectedItems = quickPick.items.filter((i) => i.picked);
        quickPick.show();
        let ignoreNext = false;
        let previousSelections = [...quickPick.selectedItems];
        const displayQuickPick = () => {
            previousSelections = Array.from(new Set(previousSelections));
            quickPick.items = items;
            quickPick.selectedItems = previousSelections;
            quickPick.show();
        };
        quickPick.onDidChangeSelection(async (e) => {
            if (ignoreNext) {
                previousSelections = [...quickPick.selectedItems];
                ignoreNext = false;
                return;
            }
            if (
                e.includes(passwordEnabled) &&
                !previousSelections.includes(passwordEnabled)
            ) {
                ignoreNext = true;
                const selectedPassword = await capturePassword(options.token);
                if (selectedPassword) {
                    password = selectedPassword;
                    passwordEnabled.description = `Password set to ${selectedPassword}`;
                    previousSelections =
                        previousSelections.concat(passwordEnabled);
                } else {
                    previousSelections = previousSelections.filter(
                        (i) => i !== passwordEnabled
                    );
                }
                return displayQuickPick();
            } else if (
                e.includes(emptyToken) &&
                !previousSelections.includes(emptyToken)
            ) {
                token.isRandom = false;
                token.isEmpty = true;
                ignoreNext = true;
                previousSelections = previousSelections
                    .filter((i) => i !== randomToken && i !== specificToken)
                    .concat(emptyToken);
                return displayQuickPick();
            } else if (
                e.includes(specificToken) &&
                !previousSelections.includes(specificToken)
            ) {
                ignoreNext = true;
                const capturedToken = await captureToken(options.token);
                if (capturedToken) {
                    token.value = capturedToken;
                    token.isRandom = false;
                    token.isEmpty = false;
                    specificToken.description = `Token set to ${capturedToken}`;
                    previousSelections = previousSelections
                        .filter((i) => i !== emptyToken && i !== randomToken)
                        .concat(specificToken);
                } else {
                    token.isRandom = true;
                    token.isEmpty = false;
                    previousSelections = previousSelections
                        .filter((i) => i !== emptyToken && i !== specificToken)
                        .concat(randomToken);
                }
                return displayQuickPick();
            } else if (
                e.includes(cwdPrompt) &&
                !previousSelections.includes(cwdPrompt)
            ) {
                ignoreNext = true;
                const capturedCwd = await captureCwd({
                    token: options.token,
                    openLabel: "Select Folder",
                    title: "Select Startup Folder for Jupyter",
                });
                if (capturedCwd) {
                    customCwd = capturedCwd;
                    useCustomWorkingDirectory = true;
                    cwdPrompt.description = getDisplayPath(capturedCwd);
                    previousSelections = previousSelections.concat(cwdPrompt);
                } else {
                    cwdPrompt.description =
                        cwd === tmpDir
                            ? "<Temporary Directory>"
                            : getDisplayPath(cwd);
                    useCustomWorkingDirectory = true;
                    previousSelections = previousSelections.filter(
                        (i) => i !== cwdPrompt
                    );
                }
                return displayQuickPick();
            } else if (
                e.includes(localPathMapping) &&
                !previousSelections.includes(localPathMapping)
            ) {
                ignoreNext = true;
                const mappedFolder = await captureCwd({
                    token: options.token,
                    openLabel: "Select Folder",
                    title: "Select Local Folder to Map to Remote Notebook Folder",
                });
                if (mappedFolder) {
                    jupyterExtensionWorkingDirectory = mappedFolder;
                    localPathMapping.description = getDisplayPath(
                        jupyterExtensionWorkingDirectory
                    );
                    previousSelections =
                        previousSelections.concat(localPathMapping);
                } else {
                    localPathMapping.description =
                        cwd === tmpDir
                            ? "<Temporary Directory>"
                            : getDisplayPath(cwd);
                    jupyterExtensionWorkingDirectory = cwd;
                    previousSelections = previousSelections.filter(
                        (i) => i !== localPathMapping
                    );
                }
                return displayQuickPick();
            } else if (
                !e.includes(cwdPrompt) &&
                previousSelections.includes(cwdPrompt)
            ) {
                ignoreNext = true;
                cwdPrompt.description = getDisplayPath(cwd);
                useCustomWorkingDirectory = true;
                previousSelections = [...quickPick.selectedItems];
                return displayQuickPick();
            } else if (!e.includes(emptyToken) && !e.includes(randomToken)) {
                ignoreNext = true;
                quickPick.selectedItems = quickPick.selectedItems
                    .filter((i) => i !== emptyToken && i !== randomToken)
                    .concat(randomToken);
            }
            previousSelections = [...quickPick.selectedItems];
        });
        const proceed = await new Promise<boolean>((resolve) => {
            quickPick.onDidTriggerButton(async (button) => {
                if (button === QuickInputButtons.Back) {
                    resolve(false);
                }
            });
            quickPick.onDidAccept(() => resolve(true));
        });
        quickPick.hide();
        if (!proceed) {
            return;
        }
        const selections = quickPick.selectedItems;
        if (quickPick.selectedItems.length === 0) {
            return;
        }

        if (!selections.length || selections.every((i) => !i.picked)) {
            return;
        }
        shouldOpenBrowser = selections?.some(
            (i) => i.label === openInBrowser.label
        );
        cors = selections?.some((i) => i.label === corsEnabled.label);
        password = selections?.some((i) => i.label === passwordEnabled.label)
            ? password
            : "";
        registerWithJupyterExtension = selections?.some(
            (i) => i.label === "Register with Jupyter Extension"
        );
        jupyterExtensionWorkingDirectory =
            selections?.some((i) => i.label === localPathMapping.label) &&
            jupyterExtensionWorkingDirectory
                ? jupyterExtensionWorkingDirectory
                : undefined;
    }
    const port = await getPorts.getPortPromise({
        host: "127.0.0.1",
        port: 8888,
    });
    if (options.token?.isCancellationRequested) {
        return;
    }
    if (token.isRandom) {
        token.value = Date.now().toString();
    } else if (token.isEmpty) {
        token.value = "";
    } else if (!token.value.trim()) {
        throw new Error("Token cannot be empty");
    }

    const shellArgs = [
        "-m",
        "jupyter",
        options.type === "Jupyter Lab" ? "lab" : "notebook",
    ];
    if (!shouldOpenBrowser) {
        shellArgs.push("--no-browser");
    }
    if (cors) {
        shellArgs.push("--NotebookApp.allow_origin");
        shellArgs.push("*");
        shellArgs.push("--ServerApp.allow_origin");
        shellArgs.push("*");
    }
    shellArgs.push("--NotebookApp.token");
    shellArgs.push(token.value.trim());
    shellArgs.push("--ServerApp.token");
    shellArgs.push(token.value.trim());
    if (password.trim().length) {
        shellArgs.push("--NotebookApp.password");
        shellArgs.push(generateHashedPassword(password));
        shellArgs.push("--ServerApp.password");
        shellArgs.push(generateHashedPassword(password));
    } else {
        shellArgs.push("--NotebookApp.password");
        shellArgs.push("");
        shellArgs.push("--ServerApp.password");
        shellArgs.push("");
    }
    if (customCwd && useCustomWorkingDirectory) {
        shellArgs.push("--notebook-dir");
        shellArgs.push(customCwd);
    } else if (cwd) {
        shellArgs.push("--notebook-dir");
        shellArgs.push(cwd);
    }
    shellArgs.push("--port");
    shellArgs.push(port.toString());

    return {
        shellArgs,
        token: token.value,
        port,
        password,
        registerWithJupyterExtension,
        cwd,
        jupyterExtensionWorkingDirectory,
    };
}

async function capturePassword(token?: CancellationToken) {
    return window.showInputBox(
        {
            prompt: "Enter password",
            title: "Enter Jupyter Password",
            validateInput(value) {
                if (!value) {
                    return "Password cannot be empty";
                }
            },
        },
        token
    );
}
async function captureCwd(options: {
    token?: CancellationToken;
    openLabel: string;
    title: string;
}) {
    const folder = await window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: workspace.workspaceFolders?.length
            ? workspace.workspaceFolders[0].uri
            : undefined,
        openLabel: options.openLabel,
        title: options.title,
    });
    if (options.token?.isCancellationRequested) {
        return;
    }
    return Array.isArray(folder) && folder.length
        ? folder[0].fsPath
        : undefined;
}
async function captureToken(token?: CancellationToken) {
    const jpToken = await window.showInputBox(
        {
            prompt: "Enter Token",
            title: "Enter Jupyter Token",
            validateInput(value) {
                if (!value) {
                    return "Token cannot be empty";
                }
            },
        },
        token
    );

    return (jpToken || "").trim();
}

function generateHashedPassword(password: string) {
    const hash = crypto.createHash("sha1");
    const salt = genRandomString(16);
    hash.update(password);
    hash.update(salt);
    return `sha1:${salt}:${hash.digest("hex").toString()}`;
}

/**
 * generates random string of characters i.e salt
 * @function
 * @param {number} length - Length of the random string.
 */
function genRandomString(length = 16) {
    return crypto
        .randomBytes(Math.ceil(length / 2))
        .toString("hex") /** convert to hexadecimal format */
        .slice(0, length); /** return required number of characters */
}
