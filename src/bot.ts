import { sleep } from "bun";
import TelegramBot from "node-telegram-bot-api";

interface QueuedMessage {
  message: string;
  chatId: string;
  retryCount: number;
}

export class Bot {
  private bot: TelegramBot;
  private messageQueue: QueuedMessage[] = [];
  private isProcessingQueue: boolean = false;
  private readonly MAX_RETRIES = 3;
  private readonly MAX_MESSAGES_PER_SECOND = 10;
  private readonly RATE_LIMIT_WAIT_TIME = 13000; // 13 seconds for Telegram rate limit
  private messagesSentTimestamps: number[] = [];

  constructor(token: string) {
    this.bot = new TelegramBot(token, {
      polling: false,
    });
  }

  private async canSendMessage(): Promise<boolean> {
    const now = Date.now();
    // Remove timestamps older than 1 second
    this.messagesSentTimestamps = this.messagesSentTimestamps.filter(
      (timestamp) => now - timestamp < 1000
    );
    return this.messagesSentTimestamps.length < this.MAX_MESSAGES_PER_SECOND;
  }

  private async waitForRateLimit(): Promise<void> {
    while (!(await this.canSendMessage())) {
      console.log("Rate limit reached, waiting 1 second");
      await sleep(5000);
    }
  }

  private async sendSingleMessage(queuedMessage: QueuedMessage): Promise<boolean> {
    try {
      await this.bot.sendMessage(queuedMessage.chatId, queuedMessage.message, {
        parse_mode: "MarkdownV2",
      });
      this.messagesSentTimestamps.push(Date.now());
      return true;
    } catch (error: any) {
      const errorMessage = error.toString();

      if (
        errorMessage.includes("429") ||
        errorMessage.includes("Too Many Requests")
      ) {
        console.log(`Rate limited. Waiting ${this.RATE_LIMIT_WAIT_TIME/1000} seconds before retry...`);
        await sleep(this.RATE_LIMIT_WAIT_TIME);
        return false;
      }

      if (queuedMessage.retryCount < this.MAX_RETRIES) {
        console.log(`Error sending message, attempt ${queuedMessage.retryCount + 1}/${this.MAX_RETRIES}`);
        queuedMessage.retryCount++;
        return false;
      }

      console.error("Failed to send message after max retries:", {
        error: errorMessage,
        message: queuedMessage.message,
        chatId: queuedMessage.chatId
      });
      return true; // Remove from queue after max retries
    }
  }

  private async processMessageQueue(): Promise<void> {
    if (this.isProcessingQueue || this.messageQueue.length === 0) return;

    this.isProcessingQueue = true;

    try {
      while (this.messageQueue.length > 0) {
        await this.waitForRateLimit();

        const currentMessage = this.messageQueue[0];
        const shouldRemove = await this.sendSingleMessage(currentMessage);

        if (shouldRemove) {
          this.messageQueue.shift();
        }
      }
    } catch (error) {
      console.error("Fatal error in message queue processing:", error);
    } finally {
      this.isProcessingQueue = false;
    }
  }

  async sendMessage(messages: string[], chatId: string): Promise<void> {
    // Validate inputs
    if (!Array.isArray(messages) || !chatId) {
      throw new Error("Invalid input: messages must be an array and chatId must be provided");
    }

    // Add messages to queue
    for (const message of messages) {
      if (typeof message === "string" && message.trim()) {
        this.messageQueue.push({
          message: message.trim(),
                               chatId,
                               retryCount: 0
        });
      }
    }

    console.log("Messages in the queue:", this.messageQueue.length);

    // Start processing if not already running
    if (!this.isProcessingQueue) {
      await this.processMessageQueue();
    }
  }

  // Add method to check queue status
  getQueueStatus(): { queueLength: number; isProcessing: boolean } {
    return {
      queueLength: this.messageQueue.length,
      isProcessing: this.isProcessingQueue
    };
  }
}
