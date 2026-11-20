// Public key that firmware updates must be signed with. Run once:
//   node tools/make-firmware-signing-key.mjs
// It makes your own key pair (the private half stays in .secrets/) and rewrites this file.
#pragma once
#error "Run  node tools/make-firmware-signing-key.mjs  first: it writes your own signing key into this file."
