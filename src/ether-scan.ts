import axios from "axios";
import { logger } from "./logger";
import type { EtherscanTx } from "./types";

export class EtherscanAPI {
  private readonly baseURL = "https://api.etherscan.io/api";
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async getContractTransactions(
    address: string,
    startBlock: number
  ): Promise<EtherscanTx[]> {
    try {
      const response = await axios.get(this.baseURL, {
        params: {
          module: "account",
          action: "txlist",
          address,
          startblock: startBlock,
          endblock: "latest",
          sort: "asc",
          apikey: this.apiKey,
        },
      });

      if (response.data.status === "1" && response.data.result) {
        return response.data.result;
      }
      return [];
    } catch (error) {
      logger.error("Etherscan API error:", error);
      throw error;
    }
  }

  async getInternalTransactions(txHash: string): Promise<any[]> {
    try {
      const response = await axios.get(this.baseURL, {
        params: {
          module: "account",
          action: "txlistinternal",
          txhash: txHash,
          apikey: this.apiKey,
        },
      });

      if (response.data.status === "1" && response.data.result) {
        return response.data.result;
      }
      return [];
    } catch (error) {
      logger.error("Etherscan API error:", error);
      throw error;
    }
  }

  async getLatestBlock(): Promise<number | null> {
    try {
      const response = await axios.get(this.baseURL, {
        params: {
          module: "proxy",
          action: "eth_blockNumber",
          apikey: this.apiKey,
        },
      });

      const blockNumber = parseInt(response.data.result, 16);
      return blockNumber;
    } catch (error: any) {
      logger.error("Error getting latest block:", error.message);
      return null;
    }
  }
}
