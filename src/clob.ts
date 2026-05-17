import {
  ApiKeyCreds,
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type TickSize,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Logger } from "./logger.js";

export { Side };

export interface ClobConfig {
  host: string;
  chainId: number;
  privateKey: string;
  signatureType: number;
  funderAddress?: string;
  apiCreds?: ApiKeyCreds;
}

export interface MarketMeta {
  tickSize: TickSize;
  minOrderSize: number;
  negRisk: boolean;
}

export class ClobService {
  private client: ClobClient;
  private logger: Logger;
  private metaCache: Map<string, { meta: MarketMeta; ts: number }> = new Map();

  private static isValidCreds(creds: unknown): creds is ApiKeyCreds {
    if (!creds || typeof creds !== "object") return false;
    const c = creds as ApiKeyCreds;
    return Boolean(c.key && c.secret && c.passphrase);
  }

  private constructor(client: ClobClient, logger: Logger) {
    this.client = client;
    this.logger = logger;
  }

  static async init(config: ClobConfig, logger: Logger): Promise<ClobService> {
    const rawKey = config.privateKey.startsWith("0x")
      ? config.privateKey
      : `0x${config.privateKey}`;
    const account = privateKeyToAccount(rawKey as `0x${string}`);
    const signer = createWalletClient({ account, transport: http() });

    const chain = config.chainId as Chain;
    const signatureType = config.signatureType as SignatureTypeV2;

    let creds = config.apiCreds;
    if (!ClobService.isValidCreds(creds)) {
      logger.info("Deriving Polymarket API keys");
      const tempClient = new ClobClient({
        host: config.host,
        chain,
        signer,
        signatureType,
        funderAddress: config.funderAddress,
      });
      const derived = await tempClient.createOrDeriveApiKey();
      if (ClobService.isValidCreds(derived)) {
        creds = derived;
        logger.info("API keys ready.");
      } else {
        throw new Error(
          "Unable to create or derive API keys. Check SIGNATURE_TYPE, PRIVATE_KEY, and FUNDER_ADDRESS/PROFILE_ADDRESS.",
        );
      }
    }

    const client = new ClobClient({
      host: config.host,
      chain,
      signer,
      creds,
      signatureType,
      funderAddress: config.funderAddress,
    });
    return new ClobService(client, logger);
  }

  async getMarketMeta(tokenId: string): Promise<MarketMeta> {
    const cached = this.metaCache.get(tokenId);
    const now = Date.now();
    if (cached && now - cached.ts < 5 * 60 * 1000) return cached.meta;

    const ob = await this.client.getOrderBook(tokenId);
    const meta: MarketMeta = {
      tickSize: ob.tick_size as TickSize,
      minOrderSize: Number(ob.min_order_size),
      negRisk: Boolean(ob.neg_risk),
    };
    this.metaCache.set(tokenId, { meta, ts: now });
    return meta;
  }

  roundToTick(price: number, tickSize: TickSize, side: Side): number {
    const tick = Number(tickSize);
    if (!Number.isFinite(tick) || tick <= 0) return price;
    const factor = 1 / tick;
    const raw = price * factor;
    const rounded = side === Side.BUY ? Math.floor(raw) : Math.ceil(raw);
    const result = rounded / factor;
    const decimals = tickSize.includes("0.0001")
      ? 4
      : tickSize.includes("0.001")
        ? 3
        : tickSize.includes("0.01")
          ? 2
          : 1;
    return Number(result.toFixed(decimals));
  }

  async placeLimitOrder(params: {
    tokenId: string;
    side: Side;
    price: number;
    size: number;
  }): Promise<void> {
    const { tokenId, side } = params;
    const meta = await this.getMarketMeta(tokenId);

    const price = this.roundToTick(params.price, meta.tickSize, side);
    const size = params.size;

    if (size < meta.minOrderSize) {
      this.logger.warn("Order size below minimum", {
        tokenId,
        size,
        min: meta.minOrderSize,
      });
      return;
    }

    const resp = await this.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        side,
        size,
      },
      { tickSize: meta.tickSize, negRisk: meta.negRisk },
      OrderType.GTC,
    );

    // V2 response: ClobErrorResponseBody = { error: string }
    //              OrderResponse          = { success: boolean, errorMsg: string, ... }
    if (!resp) return;
    const errResp = resp as { error?: string };
    if (errResp.error) {
      throw new Error(errResp.error);
    }
    const orderResp = resp as { success?: boolean; errorMsg?: string };
    if (orderResp.success === false) {
      throw new Error(orderResp.errorMsg || "Order rejected by server");
    }
  }
}
