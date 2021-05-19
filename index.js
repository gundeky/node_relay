const fs = require('fs');
const net = require('net');
const zlib = require('zlib');
const HTTPParser = require('http-parser-js').HTTPParser;
const xmlBeautify = require('xml-beautifier');

const listenPort = 8081;
// const toAddr = { host: 'localhost', port: 8080, tls: false };
// const toAddr = { host: 'www.google.com', port: 443, tls: true };
// const toAddr = { host: 'www.google.com', port: 80, tls: false };
const toAddr = { host: 'localhost', port: 5232, tls: false };

const replaceHostEnabled = false;
const writeFileEnabled = true;
const forceXmlBeautifyEnabled = true;

function getLogFileName() {
	function pad2(n) {
		return (n < 10 ? '0' : '') + n;
	}
	const date = new Date();
	const postfix = date.getFullYear().toString() + pad2(date.getMonth() + 1) + pad2(date.getDate()) + pad2(date.getHours()) + pad2(date.getMinutes()) + pad2(date.getSeconds());
	return `log_${postfix}`;
}

const logFileName = getLogFileName();

function getNewInfo() {
	return {
		buffers: [],
		trailers: [],
	};
}

function print(str) {
	console.log(str);
	if (writeFileEnabled) {
		fs.appendFileSync(logFileName, str + '\n');
	}
}

function printMessage(info) {
	let totalStr = '';
	let contentEncoding = '';
	let contentType = '';
	if (info.info.method !== undefined && info.info.method !== null) {
		totalStr = `${HTTPParser.methods[info.info.method]} ${info.info.url} HTTP/${info.info.versionMajor}.${info.info.versionMinor}\n`;
	}
	else if (info.info.statusCode !== undefined && info.info.statusCode !== null) {
		totalStr = `HTTP/${info.info.versionMajor}.${info.info.versionMinor} ${info.info.statusCode} ${info.info.statusMessage}\n`;
	}

	if (info.info.headers) {
		let headerStr = '';
		for (let i=0; i<info.info.headers.length; i+=2) {
			headerStr += `${info.info.headers[i]}: ${info.info.headers[i+1]}\n`;
			if (info.info.headers[i].toLowerCase() === 'content-encoding') {
				contentEncoding = info.info.headers[i+1];
			} else if (info.info.headers[i].toLowerCase() === 'content-type') {
				contentType = info.info.headers[i+1];
			}
		}
		totalStr += headerStr;
	}

	totalStr += '\n';

	if (info.buffers.length > 0) {
		let body = Buffer.concat(info.buffers);

		// const contentEncoding = info.info.headers['content-encoding'] || '';
		if (contentEncoding === 'br') {
			body = zlib.brotliDecompressSync(body);
		} else if (contentEncoding === 'gzip') {
			body = zlib.gunzipSync(body);
		} else if (contentEncoding === 'compress') {
			body = zlib.unzipSync(body);
		} else if (contentEncoding === 'deflate') {
			body = zlib.inflateSync(body);
		} else if (contentEncoding === 'identity') {
			// nothing
		} else {
			// nothing
		}

		// const contentType = info.info.headers['content-type'] || '';
		if (contentType.includes('text/xml') || forceXmlBeautifyEnabled) {
			totalStr += xmlBeautify(body.toString('utf8'));
		} else if (contentType.includes('text/json')) {
			totalStr += JSON.stringify(body.toString('utf8'), null, 2);
		} else {
			totalStr += body.toString('utf8');
		}
	}

	print(totalStr);
}

const relayServer = net.createServer();

relayServer.on('connection', function (cliSoc) {
	const cliPort = cliSoc.remotePort;
	const queue = [];

	let reqInfo = getNewInfo();
	let resInfo = getNewInfo();

	let reqParser = new HTTPParser(HTTPParser.REQUEST);
	reqParser[1] = (trailers, str) => {
		// console.log('>>>>> reqParser[1]:', JSON.stringify(trailers), '/', str);
		reqInfo.trailers.push({ trailers: JSON.stringify(trailers), str: str });
	}
	reqParser[2] = (info) => {
		// console.log('>>>>> reqParser[2]:', JSON.stringify(info));
		reqInfo.info = info;
	}
	reqParser[3] = (chunk, offset, length) => {
		// console.log('>>>>> reqParser[3]:', chunk.length, '/', offset, '/', length);
		reqInfo.buffers.push(chunk.slice(offset, offset + length));
	}
	reqParser[4] = () => {
		// console.log('>>>>> reqParser[4]');
		printMessage(reqInfo);
		reqInfo = getNewInfo();
	}

	let resParser = new HTTPParser(HTTPParser.RESPONSE);
	resParser[1] = (trailers, str) => {
		// console.log('>>>>> resParser[1]:', JSON.stringify(trailers), '/', str);
		resInfo.trailers.push({ trailers: JSON.stringify(trailers), str: str });
	}
	resParser[2] = (info) => {
		// console.log('>>>>> resParser[2]:', JSON.stringify(info));
		resInfo.info = info;
	}
	resParser[3] = (chunk, offset, length) => {
		// console.log('>>>>> resParser[3]:', chunk.length, '/', offset, '/', length);
		resInfo.buffers.push(chunk.slice(offset, offset + length));
	}
	resParser[4] = () => {
		// console.log('>>>>> resParser[4]');
		printMessage(resInfo);
		resInfo = getNewInfo();
	}

	print(`\n=====\n[client connect:${cliPort}]`);

	const svrSoc = net.createConnection({host: toAddr.host, port: toAddr.port}, function () {
		print(`\n=====\n[server connect:${cliPort}]`);

		if (queue.length > 0) {
			svrSoc.write(Buffer.concat(queue));
		}

		svrSoc.on('data', function (data) {
			if (!Buffer.isBuffer(data) || data.length <= 0) return;
			print(`\n=====\n[data:${cliPort}] svr->cli [${data.length}]`);

			resParser.execute(data);

			cliSoc.write(data);
		});

		svrSoc.on('close', function (hadError) {
			print(`\n=====\n[close:${cliPort}] svrSoc : hadError: ${hadError}`);
			cliSoc.destroy();
		});
	});

	cliSoc.on('data', function (data) {
		if (!Buffer.isBuffer(data) || data.length <= 0) return;
		print(`\n=====\n[data:${cliPort}] cli->svr [${data.length}]`);

		reqParser.execute(data);

		if (replaceHostEnabled) {
			const hostString = toAddr.host + (toAddr.port === 80 ? '' : ':' + toAddr.port);
			//data = new Buffer(data.toString('utf8').replace(/Host: .+\r\n/, 'Host: ' + hostString + '\r\n'));    // encoding ?
			data = new Buffer(data.toString().replace(/Host: .+\r\n/, 'Host: ' + hostString + '\r\n'));
		}

		if (svrSoc) {
			svrSoc.write(data);
		}
		else {
			queue.push(data);
		}
	});

	cliSoc.on('close', function (hadError) {
		print(`\n=====\n[close:${cliPort}] cliSoc : hadError: ${hadError}`);
		if (svrSoc) {
			svrSoc.destroy();
		}
	});
});

relayServer.on('close', function () {
	print('\n=====\n[close] relayServer close');
});

relayServer.listen(listenPort, function () {
	print('\n=====\n[listen] relayServer start:' + listenPort);
});

