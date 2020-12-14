import type { IncomingMessage, ServerResponse } from 'http';
import { verify as edVerify } from 'noble-ed25519';

/**
 * The type of interaction this request is.
 */
enum InteractionType {
  /**
   * A ping.
   */
  PING = 1,
  /**
   * A command invocation.
   */
  COMMAND = 2,
}

/**
 * The type of response that is being sent.
 */
enum InteractionResponseType {
  /**
   * Acknowledge a `PING`.
   */
  PONG = 1,
  /**
   * Acknowledge a command without sending a message.
   */
  ACKNOWLEDGE = 2,
  /**
   * Respond with a message.
   */
  CHANNEL_MESSAGE = 3,
  /**
   * Respond with a message, showing the user's input.
   */
  CHANNEL_MESSAGE_WITH_SOURCE = 4,
  /**
   * Acknowledge a command without sending a message, showing the user's input.
   */
  ACKNOWLEDGE_WITH_SOURCE = 5,
}

enum InteractionResponseFlags {
  EPHEMERAL = 1 << 6,
}

/**
 * Validates a payload from Discord against its signature and key.
 *
 * @param rawBody - The raw payload data
 * @param signature - The signature from the `X-Signature-Ed25519` header
 * @param timestamp - The timestamp from the `X-Signature-Timestamp` header
 * @param clientPublicKey - The public key from the Discord developer dashboard
 * @returns Whether or not validation was successful
 */
async function verifyKey(
  rawBody: Buffer,
  signature: string,
  timestamp: string,
  clientPublicKey: string,
): Promise<boolean> {
  try {
    return await edVerify(signature, Buffer.concat([Buffer.from(timestamp, 'utf-8'), rawBody]), clientPublicKey);
  } catch (e) {
    // In case of failure, assume verification failure and return false.
    //
    // The Point#multiply error from noble-ed25519 comes from a bad signature which cannot be parsed correctly
    // by the library. It's just a poor error handling case on the library's end which causes a vague error.
    // - LC
    return false;
  }
}

type NextFunction = (err?: Error) => void;

/**
 * Creates a middleware function for use in Express-compatible web servers.
 *
 * @param clientPublicKey - The public key from the Discord developer dashboard
 * @returns The middleware function
 */
function verifyKeyMiddleware(
  clientPublicKey: string,
): (req: IncomingMessage, res: ServerResponse, next: NextFunction) => void {
  if (!clientPublicKey) {
    throw new Error('You must specify a Discord client public key');
  }
  return async function (req: IncomingMessage, res: ServerResponse, next: NextFunction) {
    const timestamp = req.headers['x-signature-timestamp'] as string;
    const signature = req.headers['x-signature-ed25519'] as string;

    // header sanity check
    if (!timestamp || !signature) {
      res.statusCode = 401;
      res.end('Invalid headers');
      return;
    }

    async function onBodyComplete(rawBody: Buffer) {
      if (!(await verifyKey(rawBody, signature, timestamp, clientPublicKey))) {
        res.statusCode = 401;
        res.end('Invalid signature');
        return;
      }

      const body = JSON.parse(rawBody.toString('utf-8')) || {};

      if (body.type === InteractionType.PING) {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            type: InteractionResponseType.PONG,
          }),
        );
        return;
      }

      req.body = body;
      next();
    }

    if (req.body) {
      if (Buffer.isBuffer(req.body)) {
        onBodyComplete(req.body);
      } else if (typeof req.body === 'string') {
        onBodyComplete(Buffer.from(req.body, 'utf-8'));
      } else {
        console.warn(
          '[discord-interactions]: req.body was tampered with, probably by some other middleware. We recommend disabling middleware for interaction routes so that req.body is a raw buffer.',
        );
        // Attempt to reconstruct the raw buffer. This works but is risky
        // because it depends on JSON.stringify matching the Discord backend's
        // JSON serialization.
        onBodyComplete(Buffer.from(JSON.stringify(req.body), 'utf-8'));
      }
    } else {
      const chunks: Array<Buffer> = [];
      req.on('data', (chunk) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        onBodyComplete(rawBody);
      });
    }
  };
}

export { InteractionType, InteractionResponseType, InteractionResponseFlags, verifyKey, verifyKeyMiddleware };
