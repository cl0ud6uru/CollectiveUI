// Isolated OIDC discovery fixture; does not issue tokens or authenticate anyone.
import http from 'node:http';
const issuer = 'http://127.0.0.1:3110';
http.createServer((req, res) => {
  if (req.url !== '/.well-known/openid-configuration') { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ issuer, authorization_endpoint: 'https://login.microsoftonline.com/synthetic/v2.0/authorize',
    token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] }));
}).listen(3110, '127.0.0.1');
