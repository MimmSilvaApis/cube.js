import WebSocket from 'isomorphic-ws';

/**
 * @title @cubejs-client/ws-transport
 * @permalink /@cubejs-client-ws-transport
 * @menuCategory Cube.js Frontend
 * @subcategory Reference
 * @menuOrder 4
 * @description WebSocket transport for Cube.js client
 */

class WebSocketTransportResult {
  protected readonly status: unknown;

  protected readonly result: unknown;

  constructor({ status, message }: { status: unknown, message: unknown }) {
    this.status = status;
    this.result = message;
  }

  async json() {
    return this.result;
  }
}

type WebSocketTransportOptions = {
  authorization: string,
  apiUrl: string,
  // @deprecated
  hearBeatInterval?: number,
  heartBeatInterval?: number,
};

type Message = {
  messageId: number,
  requestId: any,
  method: string,
  params: string,
};

type Subscription = {
  message: Message,
  callback: (result: WebSocketTransportResult) => void,
};

class WebSocketTransport {
  protected readonly apiUrl: string;

  protected readonly heartBeatInterval: number = 60;

  protected token: string;

  protected ws: any = null;

  protected messageCounter: number = 1;

  protected messageIdToSubscription: Record<number, Subscription> = {};

  protected messageQueue: Message[] = [];

  constructor({ authorization, apiUrl, heartBeatInterval, hearBeatInterval }: WebSocketTransportOptions) {
    this.token = authorization;
    this.apiUrl = apiUrl;

    if (heartBeatInterval) {
      this.heartBeatInterval = heartBeatInterval;
    } else if (hearBeatInterval) {
      console.warn('Option hearBeatInterval is deprecated. It was replaced by heartBeatInterval.');
      this.heartBeatInterval = hearBeatInterval;
    }
  }

  set authorization(token) {
    this.token = token;

    if (this.ws) {
      this.ws.close();
    }
  }

  get authorization() {
    return this.token;
  }

  initSocket() {
    if (this.ws) {
      return this.ws.initPromise;
    }

    const ws: any = new WebSocket(this.apiUrl);

    ws.messageIdSent = {};

    ws.sendMessage = (message: any) => {
      if (!message.messageId || message.messageId && !ws.messageIdSent[message.messageId]) {
        ws.send(JSON.stringify(message));
        ws.messageIdSent[message.messageId] = true;
      }
    };

    ws.sendQueue = () => {
      this.messageQueue.forEach(message => ws.sendMessage(message));
      this.messageQueue = [];
    };

    ws.reconcile = () => {
      if (new Date().getTime() - ws.lastMessageTimestamp.getTime() > 4 * this.heartBeatInterval * 1000) {
        ws.close();
      } else {
        Object.keys(this.messageIdToSubscription).forEach(messageId => {
          // @ts-ignore
          ws.sendMessage(this.messageIdToSubscription[messageId].message);
        });
      }
    };

    ws.lastMessageTimestamp = new Date();

    ws.initPromise = new Promise(resolve => {
      ws.onopen = () => {
        ws.sendMessage({ authorization: this.authorization });
      };

      ws.onmessage = (event: any) => {
        ws.lastMessageTimestamp = new Date();

        const message: any = JSON.parse(event.data);
        if (message.handshake) {
          ws.reconcile();
          ws.reconcileTimer = setInterval(() => {
            ws.messageIdSent = {};
            ws.reconcile();
          }, this.heartBeatInterval * 1000);
          resolve();
        }

        if (this.messageIdToSubscription[message.messageId]) {
          this.messageIdToSubscription[message.messageId].callback(
            new WebSocketTransportResult(message)
          );
        }

        ws.sendQueue();
      };

      ws.onclose = () => {
        if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
        if (ws.reconcileTimer) {
          clearInterval(ws.reconcileTimer);
          ws.reconcileTimer = null;
        }
        if (this.ws === ws) {
          this.ws = null;
          if (Object.keys(this.messageIdToSubscription).length) {
            this.initSocket();
          }
        }
      };

      ws.onerror = ws.onclose;
    });

    this.ws = ws;

    return this.ws.initPromise;
  }

  protected sendMessage(message: any) {
    if (message.unsubscribe && this.messageQueue.find(m => m.messageId === message.unsubscribe)) {
      this.messageQueue = this.messageQueue.filter(m => m.messageId !== message.unsubscribe);
    } else {
      this.messageQueue.push(message);
    }

    setTimeout(async () => {
      await this.initSocket();
      this.ws.sendQueue();
    }, 100);
  }

  request(method: string, { baseRequestId, ...params }: any) {
    const message: Message = {
      messageId: this.messageCounter++,
      requestId: baseRequestId,
      method,
      params
    };

    const pendingResults: WebSocketTransportResult[] = [];
    let nextMessage: ((value: any) => void)|null = null;

    const runNextMessage = () => {
      if (nextMessage) {
        nextMessage(pendingResults.pop());
        nextMessage = null;
      }
    };

    this.messageIdToSubscription[message.messageId] = {
      message,
      callback: (result) => {
        pendingResults.push(result);
        runNextMessage();
      }
    };

    const transport = this;

    return {
      async subscribe(callback: Function) {
        transport.sendMessage(message);
        const result = await new Promise((resolve) => {
          nextMessage = resolve;
          if (pendingResults.length) {
            runNextMessage();
          }
        });
        return callback(result, () => this.subscribe(callback));
      },
      async unsubscribe() {
        transport.sendMessage({ unsubscribe: message.messageId });
        delete transport.messageIdToSubscription[message.messageId];
      }
    };
  }
}

export default WebSocketTransport;
