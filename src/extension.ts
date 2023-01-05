import * as vscode from 'vscode';
import * as nearAPI from "near-api-js";
import * as fs from 'fs';
import * as path from 'path';
import {Client} from 'pg';

import AuthSettings from "./auth";
import { BN } from 'bn.js';
import { PublicKey } from 'near-api-js/lib/utils';

const NETWORK = "mainnet";


let nearAuthSettings: AuthSettings;
let extensionContext: vscode.ExtensionContext;
let currentWidgetCode: string;

export function activate(context: vscode.ExtensionContext) {
	extensionContext = context;
	AuthSettings.init(context);
	nearAuthSettings = AuthSettings.instance;
	

	context.subscriptions.push(
		vscode.commands.registerCommand('NearSocial.start', () => {
			ExtPanel.createOrShow(context.extensionUri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('type', (args) => {
			setTimeout(() => {
			if (ExtPanel.currentPanel) {
				ExtPanel.currentPanel.updateCode(getWidgetWithCode());
			}}, 50);

			return vscode.commands.executeCommand('default:type', args);
		})
	);


	if (vscode.window.registerWebviewPanelSerializer) {
		// Make sure we register a serializer in activation event
		vscode.window.registerWebviewPanelSerializer(ExtPanel.viewType, {
			async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
				console.log(`Got state: ${state}`);
				// Reset the webview options so we use latest uri for `localResourceRoots`.
				webviewPanel.webview.options = getWebviewOptions(context.extensionUri);
				ExtPanel.revive(webviewPanel, context.extensionUri);
			}
		});
	}
}

function getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
	return {
		// Enable javascript in the webview
		enableScripts: true,

		// And restrict the webview to only loading content from our extension's `media` directory.
		localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
	};
}

/**
 * Manages cat coding webview panels
 */
class ExtPanel {
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static currentPanel: ExtPanel | undefined;

	public static readonly viewType = 'NearSocialPanel';

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionUri: vscode.Uri;
	private _disposables: vscode.Disposable[] = [];

	public static createOrShow(extensionUri: vscode.Uri) {
		const column = vscode.ViewColumn.Two;

		// If we already have a panel, show it.
		if (ExtPanel.currentPanel) {
			ExtPanel.currentPanel._panel.reveal(column);
			return;
		}

		// Otherwise, create a new panel.
		const panel = vscode.window.createWebviewPanel(
			ExtPanel.viewType,
			'NEAR Social',
			column,
			getWebviewOptions(extensionUri),
		);

		ExtPanel.currentPanel = new ExtPanel(panel, extensionUri);
	}

	public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		ExtPanel.currentPanel = new ExtPanel(panel, extensionUri);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		this._panel = panel;
		this._extensionUri = extensionUri;

		// Set the webview's initial html content
		this._update();

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programmatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Update the content based on view changes
		this._panel.onDidChangeViewState(
			e => {
				if (this._panel.visible) {
					this._update();
				}
			},
			null,
			this._disposables
		);

		// Handle messages from the webview
		this._panel.webview.onDidReceiveMessage(
			message => {
				switch (message.command) {
					case 'alert': 
						alert(message.text);
						break;
					case 'publish':
						this.Publish(message.name, message.tag);												
						return;

					case 'login':
						this.NearSignin(NETWORK, getContractId(NETWORK));
						return;

					case 'confirm-login':						
						this.CheckPublicKey(NETWORK, undefined);
						return;			
					
					case 'sign-out':
						this.DeleteKey();
						setTimeout(() => this.SendAccountDetails(), 500);												
						return;						
				}
			},
			null,
			this._disposables
		);
	}

	public async Publish(widgetName: string, widgetTag: string){
		console.log("Publish");
		const code = currentWidgetCode;
		const accountId = await nearAuthSettings.getValue("account_id") ?? "";				

		const args: any = {
			data: {
				[accountId]: {
					widget: {
						[widgetName.toLowerCase().replaceAll(" ", "")]: {
							"": code,
							metadata: {
								name: widgetName,
								tags: {
									[widgetTag]: ""
								}
							}
						}
					}
				}
			}
		};
		const resp = await this.NearCall(NETWORK, accountId, getContractId(NETWORK), "set", args, null, null);
		console.log(resp);		
		if(Object.keys(resp?.status).includes("SuccessValue")){
			alert("Success!");
		}		
	}

	public updateCode(code: string) {
		if (code) {			
			this._panel.webview.postMessage({ command: 'update-code', code });
		}
	}

	public async NearCall(network: string, accountId: string, contractId: string, method: string, args: object, gas: string | null, attachedDeposit: string | null) {
		const privateKey = await nearAuthSettings.getValue("private_key");
		const keyPair = nearAPI.utils.KeyPair.fromString(privateKey ?? "");
		console.log(`signed with ${keyPair.getPublicKey()}`);
		const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
		keyStore.setKey("default", accountId, keyPair);
		const near = await nearAPI.connect({
			networkId: "default",
			keyStore,
			masterAccount: accountId,
			nodeUrl: `https://rpc.${network}.near.org`
		});

		const account = await near.account(accountId);

		const call = await account.functionCall({
			contractId,
			methodName: method,
			args,
			gas: new BN(gas ?? "30000000000000"),
			attachedDeposit: new BN(attachedDeposit ?? "0")
		});
		console.log(call);
		return call;
	}

	public async NearView(network: string, contractId: string, methodName: string, args: object): Promise<any> {
		const near = await nearAPI.connect({
			networkId: "default",
			keyStore: undefined,
			masterAccount: undefined,
			nodeUrl: `https://rpc.${network}.near.org`
		});

		const account = await near.account(contractId);

		return await account.viewFunction({
			contractId,
			methodName,
			args
		});
	}

	public async SendAccountDetails() {
		const accountId = await nearAuthSettings.getValue("account_id");
		const publicKey = await nearAuthSettings.getValue("public_key");

		this._panel.webview.postMessage({ command: 'account-details', network: NETWORK, accountId, publicKey });
	}

	public async DeleteKey() {
		await nearAuthSettings.storeValue("public_key", "");
		await nearAuthSettings.storeValue("private_key", "");
		await nearAuthSettings.storeValue("account_id", "");
		console.log("DeleteKey");
	}

	public async NearSignin(network: string, contractId: string) {
		const keyPair = nearAuthSettings.getKeyPair();
		await nearAuthSettings.storeValue("public_key", keyPair.publicKey.toString());
		console.log("public_key stored", keyPair.publicKey.toString());
		await nearAuthSettings.storeValue("private_key", keyPair.secretKey.toString());

		nearAuthSettings.getLoginLink(network, keyPair.publicKey.toString(), "Ext", contractId).
			then(url => {
				// @ts-ignore 
				vscode.env.openExternal(url);
				this.SendAccountDetails();
			});
	}

	public async grantPermission(network: string, accountId: string){
		const publicKey = await nearAuthSettings.getValue("public_key") ?? "";	
		const args: any = {
			public_key: publicKey,
			keys: [accountId]
		};

		console.log(publicKey);
		console.log("args", args);
		console.log("getContractId(network)", getContractId(network));

		const url = await nearAuthSettings.nearGetSignUrl(accountId, "grant_write_permission", args, "1", "30000000000000",  getContractId(network), null, null, network);
		console.log(url);	
		// @ts-ignore 	
		vscode.env.openExternal(url);
	}

	public async CheckPublicKey(network: string, publicKey: string | undefined): Promise<string | null>{
		if (!publicKey){
			publicKey = await nearAuthSettings.getValue("public_key");
		}

		const client = new Client({
			user: "public_readonly",
			host: network === "testnet" ? "testnet.db.explorer.indexer.near.dev" : "mainnet.db.explorer.indexer.near.dev",
			database: network === "testnet" ? "testnet_explorer" : "mainnet_explorer",
			password: "nearprotocol",
			port: 5432,
		});

		client.connect();

		const query = `SELECT account_id FROM public.access_keys WHERE public_key = '${publicKey}' LIMIT 1`;

		const response = await client.query(query);

		if(response.rows.length){
			const accountId = response.rows[0]?.account_id;
			if(accountId){
				await nearAuthSettings.storeValue("account_id", accountId);
				alert(`NEAR account ${accountId} successfully logged in!`);
				alert(`Now grant permission in the NEAR wallet to proceed`);
				await this.grantPermission(NETWORK, accountId);

				setTimeout(() => this.SendAccountDetails(), 500);
				return accountId;
			}
		}
		else {
			alert("Login details were not found in the NEAR blockchain. Please try again later");
		}

		return null;
	}

	public dispose() {
		ExtPanel.currentPanel = undefined;

		// Clean up our resources
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	private _update() {
		const webview = this._panel.webview;
		this._panel.title = "NEAR Social";
		this._panel.webview.html = this._getHtmlForWebview(webview);
		this.SendAccountDetails();
	}

	private getPanel(conext: vscode.ExtensionContext): string {
		const filePath: vscode.Uri = vscode.Uri.file(path.join(conext.extensionPath, 'media', 'panel.html'));
		return fs.readFileSync(filePath.fsPath, 'utf8');
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		const scriptPathOnDisk = vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js');
		const styleResetPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css');
		const stylesPathMainPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css');

		return this.getPanel(extensionContext)
			.replaceAll("{{cspSource}}", webview.cspSource)
			.replaceAll("{{nonce}}", getNonce())
			.replace("{{widgetCode}}", getWidgetWithCode())
			.replace("{{stylesResetUri}}", webview.asWebviewUri(styleResetPath).toString())
			.replace("{{stylesMainUri}}", webview.asWebviewUri(stylesPathMainPath).toString())
			.replace("{{scriptUri}}", webview.asWebviewUri(scriptPathOnDisk).toString());
	}
}

function getWidgetUrl (network: string) {
	return network === "testnet" 
		? "https://test.near.social/#/embed/test_alice.testnet/widget/remote-code?code="
		: "https://near.social/#/embed/zavodil.near/widget/remote-code?code=";
}

function getContractId(network: string) {
	return network === "testnet" 
		? "v1.social08.testnet"
		: "social.near";
}

function alert(text: string) {
	vscode.window.showInformationMessage(text);
}

function getWidgetWithCode(): string {
	currentWidgetCode = vscode.window.activeTextEditor?.document.getText() ?? "";
	return getWidgetUrl(NETWORK) + encodeURIComponent(currentWidgetCode);
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
