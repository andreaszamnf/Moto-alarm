// Generates the key pair for push notifications. Run once before the first deploy:
//   npm run vapid
// then paste the printed JSON into `npx wrangler secret put VAPID_PRIVATE_JWK`.
import { generateVapidKeys } from '../server/src/push.js';

const { privateJwk, publicKey } = await generateVapidKeys();
console.log('VAPID_PRIVATE_JWK (μυστικό, μην το μοιραστείς):');
console.log(JSON.stringify(privateJwk));
console.log('\nΔημόσιο κλειδί (μόνο για έλεγχο):');
console.log(publicKey);
