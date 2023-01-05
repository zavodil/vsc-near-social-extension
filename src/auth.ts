import { ExtensionContext, SecretStorage } from "vscode";
import * as nearAPI from "near-api-js";
import { BN } from "bn.js";

export default class AuthSettings {
	private static _instance: AuthSettings;

	constructor(private secretStorage: SecretStorage) { }

	static init(context: ExtensionContext): void {
		/*
		Create instance of new AuthSettings.
		*/
		AuthSettings._instance = new AuthSettings(context.secrets);
	}

	static get instance(): AuthSettings {
		/*
		Getter of our AuthSettings existing instance.
		*/
		return AuthSettings._instance;
	}

	async storeValue(key: string, value?: string): Promise<void> {
		this.secretStorage.store(key, value ?? "");
	}

	async getValue(key: string): Promise<string | undefined> {
		return await this.secretStorage.get(key);
	}

	getKeyPair(): nearAPI.utils.KeyPairEd25519 {
		return nearAPI.utils.KeyPairEd25519.fromRandom();
	}

	async getLoginLink(network: string, publicKey: string, appName: string | null, contractName: string | null) {
		const contractNameRequest = contractName ? `&contract_id=${contractName.toLowerCase()}` : "";

		return `https://wallet.${network}.near.org/login/?title=${appName}&public_key=${encodeURIComponent(publicKey)}${contractNameRequest}`;
	}

	async nearGetSignUrl(account_id: string, method: string, params: any, deposit: string | number, gas: string | number, receiver_id: string, meta: string | null, callback_url: string | null, network: string): Promise<string> {
		if (!network)
			network = "mainnet";

		let actions = [];

		const deposit_value = typeof deposit == 'string' ? deposit : nearAPI.utils.format.parseNearAmount('' + deposit) ?? 0;
		actions = [nearAPI.transactions.functionCall(method, Buffer.from(JSON.stringify(params)), new BN(gas), new BN(deposit_value))];


		const keypair = nearAPI.utils.KeyPair.fromRandom('ed25519');
		const provider = new nearAPI.providers.JsonRpcProvider({ url: 'https://rpc.' + network + '.near.org' });
		const block = await provider.block({ finality: 'final' });

		const txs = [nearAPI.transactions.createTransaction(account_id, keypair.getPublicKey(), receiver_id, 1, actions, nearAPI.utils.serialize.base_decode(block.header.hash))];

		const newUrl = new URL('sign', 'https://wallet.' + network + '.near.org/');
		newUrl.searchParams.set('transactions', txs
			.map(transaction => nearAPI.utils.serialize.serialize(nearAPI.transactions.SCHEMA, transaction))
			.map(serialized => Buffer.from(serialized).toString('base64'))
			.join(','));
		newUrl.searchParams.set('callbackUrl', callback_url ?? "");
		if (meta)
			newUrl.searchParams.set('meta', meta);
		return newUrl.href;

	}	
}