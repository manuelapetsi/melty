import {
	Disposable,
	Webview,
	Uri,
	WebviewViewProvider,
	WebviewView,
} from "vscode";
import * as vscode from "vscode";
import { getUri, getNonce } from "./util/utils";
import { Conversation, TaskMode } from "./types";
import { MeltyExtension } from "./extension";
import { createNewDehydratedTask } from "./backend/tasks";
import * as config from "./util/config";
import { WebviewNotifier } from "./services/WebviewNotifier";
import { FileManager } from "./services/FileManager";
import { DehydratedTask, RpcMethod } from "./types";
import { Coder } from "./backend/assistants/coder";
import { Vanilla } from "./backend/assistants/vanilla";
import { GitManager } from "./services/GitManager";
import { GitHubManager } from './services/GitHubManager';
import { TaskManager } from './services/TaskManager';
import posthog from "posthog-js";

/**
 * This class manages the state and behavior of HelloWorld webview panels.
 *
 * It contains all the data and methods for:
 *
 * - Creating and rendering HelloWorld webview panels
 * - Properly cleaning up and disposing of webview resources when the panel is closed
 * - Setting the HTML (and by proxy CSS/JavaScript) content of the webview panel
 * - Setting message listeners so data can be passed between the webview and extension
 */
export class HelloWorldPanel implements WebviewViewProvider {
	public static currentView: HelloWorldPanel | undefined;
	private _view?: WebviewView;
	private _disposables: Disposable[] = [];
	private fileManager?: FileManager;
	private todoCheckInterval: NodeJS.Timeout | null = null;

	private MeltyExtension: MeltyExtension;

	constructor(
		private readonly _extensionUri: Uri,
		MeltyExtension: MeltyExtension,
		private readonly _gitManager: GitManager = GitManager.getInstance(),
		private readonly _gitHubManager: GitHubManager = GitHubManager.getInstance(),
		private readonly _taskManager: TaskManager = TaskManager.getInstance(),
		private readonly _fileManager: FileManager = FileManager.getInstance(),
		private readonly _webviewNotifier: WebviewNotifier = WebviewNotifier.getInstance()
	) {
		this.MeltyExtension = MeltyExtension;
	}

	public resolveWebviewView(webviewView: WebviewView) {
		console.log("Resolving WebviewView for ChatView");
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				Uri.joinPath(this._extensionUri, "out"),
				Uri.joinPath(this._extensionUri, "webview-ui/build"),
			],
		};

		webviewView.webview.html = this._getWebviewContent(webviewView.webview);

		this._setWebviewMessageListener(webviewView.webview);

		this._webviewNotifier.setView(this._view);

		// Start the todo check interval
		// this.todoCheckInterval = setInterval(() => this.checkAndSendTodo(), 10000);
		// this.MeltyExtension.pushSubscription(new vscode.Disposable(() => {
		// 	if (this.todoCheckInterval) {
		// 		clearInterval(this.todoCheckInterval);
		// 	}
		// }));

		console.log("success in resolveWebviewView!");
	}

	private checkAndSendTodo() {
		const todo = this.MeltyExtension.getCurrentTodo();
		if (todo) {
			this._view?.webview.postMessage({
				type: "updateTodo",
				todo: todo,
			});
		}
	}

	/**
	 * Defines and returns the HTML that should be rendered within the webview panel.
	 *
	 * @remarks This is also the place where references to the React webview build files
	 * are created and inserted into the webview HTML.
	 *
	 * @param webview A reference to the extension webview
	 * @param extensionUri The URI of the directory containing the extension
	 * @returns A template string literal containing the HTML that should be
	 * rendered within the webview panel
	 */
	private _getWebviewContent(webview: Webview) {
		// The CSS file from the React build output
		const stylesUri = getUri(webview, this._extensionUri, [
			"webview-ui",
			"build",
			"static",
			"css",
			"main.css",
		]);
		// The JS file from the React build output
		const scriptUri = getUri(webview, this._extensionUri, [
			"webview-ui",
			"build",
			"static",
			"js",
			"main.js",
		]);

		const nonce = getNonce();

		// Tip: Install the es6-string-html VS Code extension to enable code highlighting below
		return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
          <meta name="theme-color" content="#000000">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https://*.posthog.com; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' 'unsafe-inline' https://*.posthog.com; connect-src https://*.posthog.com;">
          <link rel="stylesheet" type="text/css" href="${stylesUri}">
          <title>Melty</title>
        </head>
        <body>
          <noscript>You need to enable JavaScript to run this app.</noscript>
          <div id="root"></div>
          <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>
    `;
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is recieved.
	 *
	 * @param webview A reference to the extension webview
	 * @param context A reference to the extension context
	 */
	private _setWebviewMessageListener(webview: Webview) {
		webview.onDidReceiveMessage((message) => {
			if (message.type === "rpc") {
				console.log(
					`[RPC Server] RPC call for ${message.method
					} with params ${JSON.stringify(message.params)}`
				);
				this.handleRPCCall(message.method as RpcMethod, message.params)
					.then((result) => {
						console.log(
							`[RPC Server] sending RPC response for ${message.id} (${message.method})`
						);
						webview.postMessage({
							type: "rpcResponse",
							method: message.method,
							id: message.id,
							result,
						});
					})
					.catch((error) => {
						if (config.DEV_MODE) {
							throw error;
						}

						console.log(
							`[RPC Server] sending RPCresponse for ${message.id} with error ${error.message}`
						);
						webview.postMessage({
							type: "rpcResponse",
							method: message.method,
							id: message.id,
							error: error.message,
						});
					});
			}
		});
	}

	private async notifyWebviewOfChatError(taskId: string, message: string) {
		const task = this._taskManager.getActiveTask(taskId)!;
		if (task === null) {
			console.warn(`Couldn't notify webview of error because task ${taskId} was not active`);
		}
		task.addErrorJoule(message);
		await WebviewNotifier.getInstance().sendNotification("updateTask", {
			task: task.dehydrateForWire(),
		});
	}

	private async handleRPCCall(method: RpcMethod, params: any): Promise<any> {
		try {
			switch (method) {
				case "getActiveTask":
					return await this.rpcGetActiveTask(params.taskId);
				case "listMeltyFiles":
					return await this.rpcListMeltyFiles();
				case "listWorkspaceFiles":
					return await this.rpcListWorkspaceFiles();
				case "addMeltyFile":
					return await this.rpcAddMeltyFile(params.filePath);
				case "dropMeltyFile":
					return await this.rpcDropMeltyFile(params.filePath);
				case "undoLatestCommit":
					return await this.rpcUndoLatestCommit(params.commitId);
				case "getLatestCommit":
					return await this.rpcGetLatestCommit();
				case "chatMessage":
					return await this.rpcChatMessage(params.text, params.taskId);
				case "createTask":
					return await this.rpcCreateTask(
						params.name,
						params.taskMode,
						params.files
					);
				case "listTaskPreviews":
					return this.rpcListTaskPreviews();
				case "activateTask":
					return await this.rpcActivateTask(params.taskId);
				case "deactivateTask":
					return await this.rpcDeactivateTask(params.taskId);
				case "createPullRequest":
					return await this.rpcCreatePullRequest();
				case "deleteTask":
					return await this.rpcDeleteTask(params.taskId);
				case "getGitConfigErrors":
					return await this.rpcGetGitConfigErrors();
				case "getAssistantDescription":
					return await this.rpcGetAssistantDescription(params.assistantType);
				case "getVSCodeTheme":
					return this.rpcGetVSCodeTheme();
				default:
					throw new Error(`Unknown RPC method: ${method}`);
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			if (
				errorMessage === "Cannot read properties of null (reading 'repository')"
			) {
				vscode.window.showErrorMessage("Melty didn't see a git repo in your root directory. Create one?");
			} else {
				vscode.window.showErrorMessage(
					`Melty internal error: ${errorMessage}. Please try again.`
				);
			}

			if (method === "chatMessage") {
				await this.notifyWebviewOfChatError(params.taskId, errorMessage);
				await WebviewNotifier.getInstance().resetStatusMessage();
			}

			const result = posthog.capture("melty_errored", {
				type: "rpc_error",
				errorMessage: errorMessage,
				context: JSON.stringify({ ...params, rpcMethod: method }),
			});
			console.log("posthog event captured!", result);

			throw error;
		}
	}

	private async rpcGetAssistantDescription(
		taskMode: TaskMode
	): Promise<string> {
		switch (taskMode) {
			case "coder":
				return Coder.description;
			case "vanilla":
				return Vanilla.description;
			default:
				throw new Error(`Unknown assistant type: ${taskMode}`);
		}
	}

	private async rpcGetActiveTask(taskId: string): Promise<DehydratedTask | undefined> {
		const task = this._taskManager.getActiveTask(taskId);
		if (!task) {
			vscode.window.showErrorMessage(`Failed to get active task ${taskId}`);
		}
		return task!.dehydrate();
	}

	private async rpcListMeltyFiles(): Promise<string[]> {
		const meltyMindFilePaths = this._fileManager!.getMeltyMindFilesRelative();
		return Promise.resolve(meltyMindFilePaths);
	}

	private async rpcListWorkspaceFiles(): Promise<string[]> {
		const workspaceFilePaths =
			await this._fileManager!.getWorkspaceFilesRelative();
		return workspaceFilePaths;
	}

	private async rpcAddMeltyFile(filePath: string): Promise<string[]> {
		await this._fileManager!.addMeltyMindFile(filePath, false);
		vscode.window.showInformationMessage(`Added ${filePath} to Melty's Mind`);
		return this._fileManager!.getMeltyMindFilesRelative();
	}

	private async rpcDropMeltyFile(filePath: string): Promise<string[]> {
		this._fileManager!.dropMeltyMindFile(filePath);
		vscode.window.showInformationMessage(
			`Removed ${filePath} from Melty's Mind`
		);
		return await this._fileManager!.getMeltyMindFilesRelative();
	}

	private async rpcCreateTask(
		name: string,
		taskMode: TaskMode,
		files: string[]
	): Promise<string> {
		const task = createNewDehydratedTask(name, taskMode, files);
		this._taskManager.add(task);
		return task.id;
	}

	private rpcListTaskPreviews(): DehydratedTask[] {
		return this._taskManager.listInactiveTasks();
	}

	private async rpcCreatePullRequest(): Promise<void> {
		await this._gitHubManager.createPullRequest();
	}

	private async rpcDeleteTask(taskId: string): Promise<void> {
		await this._taskManager.delete(taskId);
	}

	private async rpcGetGitConfigErrors(): Promise<string> {
		const result = this._gitManager.init();
		return typeof result === "string" ? result : "";
	}

	private async rpcGetLatestCommit(): Promise<string | undefined> {
		return await this._gitManager.getLatestCommitHash();
	}

	private async rpcUndoLatestCommit(commitId: string): Promise<void> {
		const errMessage = this._gitManager.undoLastCommit(commitId);
		if (errMessage === null) {
			vscode.window.showInformationMessage(
				"Last commit has been undone by hard reset."
			);
		} else {
			vscode.window.showErrorMessage("Failed to undo last commit: " + errMessage);
		}
	}

	private async rpcDeactivateTask(taskId: string): Promise<boolean> {
		const errMessage = await this._taskManager.deactivate(taskId);
		if (errMessage) {
			vscode.window.showErrorMessage(`Failed to deactivate task ${taskId}: ${errMessage}`);
			return false;
		}
		return false;
	}

	private async rpcActivateTask(taskId: string): Promise<boolean> {
		const errorMessage = await this._taskManager.activate(taskId);
		if (errorMessage) {
			vscode.window.showErrorMessage(`Failed to activate task ${taskId}: ${errorMessage}`);
			return false;
		}
		return true;
	}

	private rpcGetVSCodeTheme(): string {
		return vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light';
	}

	private async rpcChatMessage(text: string, taskId: string): Promise<void> {
		const webviewNotifier = WebviewNotifier.getInstance();
		webviewNotifier.updateStatusMessage("Starting up");
		const task = this._taskManager.getActiveTask(taskId)!;
		if (!task) {
			throw new Error(`Tried to chat with an inactive task ${taskId} (active task is ${this._taskManager.getActiveTaskId()})`);
		}

		// human response
		await task.respondHuman(text);
		webviewNotifier.sendNotification("updateTask", {
			task: task.dehydrateForWire(),
		});

		// bot response
		const processPartial = (partialConversation: Conversation) => {
			const dehydratedTask = task.dehydrateForWire();
			dehydratedTask.conversation = partialConversation;
			webviewNotifier.sendNotification("updateTask", {
				task: dehydratedTask,
			});
		};
		await task.respondBot(processPartial);

		webviewNotifier.sendNotification("updateTask", {
			task: task.dehydrateForWire(),
		});
		webviewNotifier.resetStatusMessage();
	}
}
