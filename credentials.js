const fs = require('fs')
const path = require('path')
require('dotenv/config');

const cert2 = path.resolve(process.cwd(''), `src/certs/${process.env.EFIPAY_CERTIFICATE}`);

const client = process.env.EFIPAY_CLIENT_ID;
const secret = process.env.EFIPAY_CLIENT_SECRET;
const sandBox = process.env.EFIPAY_SANDBOX; 

//let cert = Buffer.from(process.env.EFIPAY_CERTIFICATE, 'base64')
//let cert = '/certs/homologacao-499441-NextBet.p12'

//console.log(sandBox);
//console.log(client);
//console.log(secret);
//console.log(cert2);
//console.log('credentials');

module.exports = {
	// PRODUÇÃO = false      // HOMOLOGAÇÃO = true
	sandbox: false,
	client_id: client,
	client_secret: secret,
	certificate: cert2,	
}