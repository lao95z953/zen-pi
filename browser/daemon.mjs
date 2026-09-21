import { createBrowserBridge } from './bridge.mjs';
import { connection } from './client.mjs';

const config = await connection();
const bridge = await createBrowserBridge({ token: config.token });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => bridge.close());
