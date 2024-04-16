process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const WebSocket = require('ws');
const mysql = require('mysql');
const punycode = require('idna-uts46-hx');
const request = require('request');
const fs = require('fs');
const { Expo } = require("expo-server-sdk");

const config = require("./config.json");

var wss;
var Janode;
var janus;

var sessions = [];
var users = [];
var channels = [];
var pms = [];
var slds = [];
var typing = {};

var userColumns = "d.id, d.domain, d.type, d.tld, d.avatar, d.locked, d.deleted, d.created, d.bio, d.admin, s.pubkey pubkey, s.id sid, s.push push";

const sql = mysql.createPool({
	host: config.sqlHost,
	user: config.sqlUser,
	password: config.sqlPass,
	database: config.sqlDatabase,
	charset : "utf8mb4"
});

function log(e) {
	//console.log(e);
}

async function db(query, values=[]) {
	let result = new Promise(resolve => {
		sql.query(query, values, (e, r, f) => {
			try {
				resolve(JSON.parse(JSON.stringify(r)));
			}
			catch {
				log(e);
			}
		});
	});
	return await result;
}

const makeID = (length) => {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function time() {
	return Math.floor(Date.now() / 1000);
}

const rtrim = (str, chr) => str.replace(new RegExp(!chr ? '\\s+$' : chr + '+$'), '');

async function get(url, proxy=false) {
	var options = {
		timeout: 1000
	};
	if (proxy) {
		options.proxy = "http://127.0.0.1:8080"
	}

	let output = new Promise(resolve => {
		request(url, options, (e, r, b) => {
			if (b) {
				resolve(b.trim());
			}
			resolve();
		});
	});

	return await output;
}

const getMethods = (obj) => {
  let properties = new Set()
  let currentObj = obj
  do {
    Object.getOwnPropertyNames(currentObj).map(item => properties.add(item))
  } while ((currentObj = Object.getPrototypeOf(currentObj)))
  return [...properties.keys()].filter(item => typeof obj[item] === 'function')
}

async function janusConnect() {
	janus = await Janode.connect({
		is_admin: true,
		address: {
			url: config.janusWs,
			apisecret: config.janusKey
		}
	});
	return;
}

async function janusRequest(request) {
	if (!janus || janus._transport._closed) {
		await janusConnect();
	}

	let response = await janus.sendRequest(request);
	return response;
}

async function makeVideoRoom(id, name) {
	return await janusRequest({
		janus: "message_plugin",
		plugin: "janus.plugin.videoroom",
		request: {
			request: "create",
			admin_key: config.janusKey,
			secret: config.janusKey,
			is_private: true,
			permanent: true,

			room: id,
			description: name,
			
			publishers: 10,
			audiolevel_event: true,
			audio_active_packets: 10,
			audio_level_average: 50,
			notify_joining: true,
			fir_freq: 10,
			bitrate: 4096000
		}
	});
}

async function init() {
	Janode = await import(`${config.path}/node_modules/janode/src/janode.js`).then(module => {
		return module.default;
	});

	await fetchUsers();
	await fetchChannels();

	await db("SELECT id, users FROM conversations").then(r => {
		pms = r;

		pms.forEach((c, k) => {
			db("SELECT time FROM messages WHERE conversation = ? ORDER BY ai DESC LIMIT 1", [c.id]).then(r => {
				if (r.length) {
					pms[k].activity = r[0].time;
				}
			});
		});
	});

	wss = new WebSocket.Server({ port: 4444 });
	wss.on('connection', (ws, req) => {
		try {
			ws.ip = req.headers['x-forwarded-for'].split(',')[0].trim();
		}
		catch {
			ws.ip = req.socket.remoteAddress;
		}

		log(`CONNECT ${ws.ip}`);

		ws.on('message', data => {
			let user = dataForUser(ws.domain);
			if (user) {
				log(`IN [${user.domain}]: ${data}`);
			}
			else {
				log(`IN [${ws.ip}]: ${data}`);
			}
			parse(ws, data);
		});

		ws.on('close', () => {
			if (!activeUsers().includes(ws.domain)) {
				removeUserFromVideoChatsIfNeeded(ws.domain);
				sendToAllClients("DISCONNECTED", ws.domain);
			}
			log(`DISCONNECT ${ws.ip}`);
		});

		ws.on('error', console.error)
	});

	setInterval(() => {
		typingUpdates();
	}, 1000);

	setInterval(() => {
		fetchUsers();
		fetchChannels();
	}, 300000);

	log("READY");
}

async function fetchUsers() {
	await db(`SELECT ${userColumns} FROM domains d LEFT JOIN sessions s ON s.id = d.session`).then(r => {
		let newUsers = [];
		let newSessions = [];

		r.forEach((u, k) => {
			newSessions.push({
				domain: u.id,
				session: u.sid,
				push: u.push
			});

			delete u.sid;
			delete u.push;
			newUsers.push(u);
		});

		users = newUsers;
		sessions = newSessions;
	});
}

async function fetchChannels() {
	await db("SELECT * FROM channels WHERE hidden = 0").then(r => {
		let newChannels = r;
		if (channels.length) {
			let currentChannels = channels;

			newChannels.forEach((nc, k) => {
				let exists = currentChannels.filter(cc => {
					return cc.id == nc.id;
				});

				if (!exists.length) {
					sendToAllClients("CHANNEL", nc);
				}
			});
		}
		
		let oldChannels = channels;
		channels = newChannels;

		channels.forEach((c, k) => {
			let old = oldChannels.filter(chan => {
				return c.id == chan.id; 
			})[0];
			if (oldChannels.length && old) {
				channels[k].video = old.video;
				channels[k].videoUsers = old.videoUsers;
				channels[k].videoWatchers = old.videoWatchers;
				channels[k].videoSpeakers = old.videoSpeakers;
			}
			else {
				channels[k].video = false;
				channels[k].videoUsers = {};
				channels[k].videoWatchers = [];
				channels[k].videoSpeakers = [];
			}

			db("SELECT time FROM messages WHERE conversation = ? ORDER BY ai DESC LIMIT 1", [c.id]).then(r => {
				if (r.length) {
					channels[k].activity = r[0].time;
				}
			});
		});

		slds = getStaked();
	});
}

function typingUpdates() {
	Object.keys(typing).forEach((k) => {
		let typer = typing[k];

		if ((Date.now() - typer.time) >= config.typingDelay) {
			delete typing[k];
		}
		else {
			let data = {
				from: k,
				to: typer.to
			}
			sendToUsers("TYPING", data, typer.to);
		}
	});
}

async function generateID(type) {
	var id,output;
	var database,param,length,prefix;

	switch (type) {
		case "session":
			database = "sessions";
			param = "id";
			length = 32;
			prefix = "V2-";
			break;

		case "domain":
			database = "domains";
			param = "id";
			length = 16;
			break;

		case "message":
			database = "messages";
			param = "id";
			length = 32;
			break;

		case "pm":
			database = "conversations";
			param = "id";
			length = 16;
			break;

		case "channel":
			database = "channels";
			param = "id";
			length = 8;
			break;

		default:
			return;
	}

	while (!output) {
		id = makeID(length);
		if (prefix) {
			id = `${prefix}${id}`;
		}

		await db(`SELECT * FROM ${database} WHERE ${param} = ?`, [id]).then(r => {
			if (!r.length) {
				output = id;
			}
		});
	}

	return output;
}

function parse(ws, data) {
	let message = data.toString();
	let parsed = message.match(/(?<command>[A-Z]+)(\s(?<body>.+))?/);

	try {
		handle(ws, parsed.groups);
	}
	catch (e) {
		log(e);
	}
}

function sendSuccess(ws, type, data={}) {
	let d = {
		type: type
	}
	let merged = {...d, ...data};

	sendMessage(ws, "SUCCESS", merged);
}

function sendError(ws, type, message, data={}) {
	let d = {
		type: type,
		message: message
	}
	let merged = {...d, ...data};

	sendMessage(ws, "ERROR", merged);
}

async function handle(ws, parsed) {
	var match;
	var success;

	var names;
	var domain;
	var response,r;

	let command = parsed.command;
	let body = parsed.body;

	var data;

	if (ws.invalid) {
		return;
	}

	try {
		body = JSON.parse(body);
	}
	catch {}

	switch (command) {
		case "ACTION":
			log(`KILL ${ws.ip}`);
			ws.close();
			break;

		case "PING":
		case "IDENTIFY":
		case "DOMAINS":
		case "DOMAIN":
		case "ADDDOMAIN":
		case "ADDSLD":
		case "DELETEDOMAIN":
		case "STAKED":
		case "VERIFYDOMAIN":
			break;

		default:
			if (!ws.domain) {
				return;
			}
			break;
	}

	switch (command) {
		case "PING":
			let version = await currentVersion();
			let active = activeUsers();
			data = {
				version: version,
				active: active
			}

			sendMessage(ws, `PONG ${JSON.stringify(data)}`);
			break;

		case "IDENTIFY":
			db("SELECT * FROM sessions WHERE id = ?", [body]).then(r => {
				try {
					data = {};
					if (r[0].seen) {
						data.seen = r[0].seen;
					}

					ws.session = r[0].id;
					sendMessage(ws, `IDENTIFIED ${JSON.stringify(data)}`);
				}
				catch {
					ws.close();
				}
			});
			break;

		case "USERS":
			sendMessage(ws, command, users);
			break;

		case "STAKED":
			sendMessage(ws, command, slds);
			break;

		case "DOMAINS":
			db("SELECT id, domain, tld, locked FROM domains WHERE session = ? AND deleted = 0", [ws.session]).then(r => {
				try {
					ws.domains = r;
					sendMessage(ws, command, r);
				}
				catch {}
			});
			break;

		case "DOMAIN":
			if (!ws.domains) {
				break;
			}

			match = ws.domains.filter(d => {
				return d.id == body;
			});

			if (match.length) {
				let oldDomain = ws.domain;
				removeUserFromVideoChatsIfNeeded(oldDomain);

				ws.domain = body;
				sendMessage(ws, command, body);

				if (oldDomain && !activeUsers().includes(oldDomain)) {
					sendToAllClients("DISCONNECTED", oldDomain);
				}
				
				sendToAllClients("CONNECTED", ws.domain);
			}
			else {
				sendError(ws, command, "The provided domain ID doesn't exist.");
			}
			break;

		case "ADDDOMAIN":
			response = await get(`https://auth.varo.domains/verify/${body.request}`);
			if (response) {
				let r = JSON.parse(response);

				if (r.success) {
					let name = r.data.name;
					let tld = tldForDomain(name);

					if (canCreateSLD(tld)) {
						sendError(ws, command, "Create a free SLD in the other field for this TLD.");
					}
					else {
						let type = r.data.type;

						let id = await addDomain(ws, name, type);
						if (id) {
							sendSuccess(ws, command, { id: id });
						}
						else {
							sendError(ws, command, "Something went wrong. Try again.");
						}

						/*
						if (type !== "unstoppable") {
							type = "handshake";
						}

						if (type == "unstoppable") {
							sendError(ws, command, "Unstoppable Domains are no longer supported.");
						}
						else {
							let id = await addDomain(ws, name, type);
							if (id) {
								sendSuccess(ws, command, { id: id });
							}
							else {
								sendError(ws, command, "Something went wrong. Try again.");
							}
						}
						*/
					}
				}
				else {
					sendError(ws, command, "Verification failed. Try again.");
				}
			}
			break;

		case "VERIFYDOMAIN":
			response = await get(`https://auth.varo.domains/verify/${body.request}`);
			if (response) {
				let r = JSON.parse(response);

				if (r.success) {
					let user = dataForUser(body.id);
					if (user.domain == r.data.name) {
						let unlock = await unlockDomain(body.id, r.data.name);
						if (unlock) {
							sendSuccess(ws, command, { id: body.id });
						}
						else {
							sendError(ws, command, "Something went wrong. Try again.");
						}
					}
					else {
						sendError(ws, command, "Something went wrong. Try again.");
					}
				}
				else {
					sendError(ws, command, "Verification failed. Try again.");
				}
			}
			break;

		case "ADDSLD":
			if (body.sld && body.tld) {
				if (!canCreateSLD(body.tld)) {
					sendError(ws, command, "The TLD provided isn't valid for creating an SLD.");
					break;
				}

				if (!validName(body.sld)) {
					sendError(ws, command, "The name provided isn't valid.");
					break;
				}

				if (!isAvailableSLD(body.tld, body.sld)) {
					sendError(ws, command, "The name provided isn't available.");
					break;
				}

				let id = await addDomain(ws, `${body.sld}.${body.tld}`, "handshake");
				if (id) {
					sendSuccess(ws, command, { id: id });
				}
				else {
					sendError(ws, command, "Something went wrong. Try again.");
				}
			}
			else {
				sendError(ws, command, "Something went wrong. Try again.");
			}
			break;

		case "DELETEDOMAIN":
			await db("UPDATE domains SET deleted = 1, LOCKED = 1 WHERE id = ? AND session = ?", [body.id, ws.session]);
			sendUser(body.id);
			sendSuccess(ws, command, { id: body.id });
			break;

		case "CHANNELS":
			data = [];

			channels.forEach((c, k) => {
				let channelData = {
					id: c.id,
					name: c.name,
					public: c.public,
					tldadmin: c.tldadmin,
					admins: c.admins,
					activity: c.activity,
					pinned: c.pinned,
					video: c.video,
					videoUsers: c.videoUsers,
					videoWatchers: c.videoWatchers,
					videoSpeakers: c.videoSpeakers
				}
				data.push(channelData);
			});

			sendMessage(ws, command, data);
			break;

		case "PMS":
			let subset = pms.filter(a => {
				return JSON.parse(a.users).includes(ws.domain);
			});
			sendMessage(ws, command, subset);
			break;

		case "PM":
			domain = body.domain.replace(/[\s\/]+$/, '');
			let puny = punycode.toAscii(domain);

			if (puny) {
				let domainData = dataForDomain(puny);
				if (domainData) {
					let to = domainData.id;

					if (to == ws.domain) {
						sendError(ws, command, "You can't private message yourself.");
						return;
					}

					let getPM = await db("SELECT id, users FROM conversations WHERE JSON_CONTAINS(users, ?, '$') AND JSON_CONTAINS(users, ?, '$')", [`"${ws.domain}"`, `"${to}"`]).then(r => {
						if (r.length) {
							return r[0];
						}
						return false;
					});

					if (getPM) {
						sendError(ws, command, "You already have a PM open with this domain.", { id: getPM.id });
					}
					else {
						let id = await generateID("pm");
						let users = JSON.stringify([ws.domain, to]);

						let conversation = await db("INSERT INTO conversations (id, users) VALUES (?,?)", [id, users]).then(r => {
							if (r) {
								let data = {
									id: id,
									users: users
								};
								pms.push(data);
								return data;
							}
							return false;
						});

						if (conversation) {
							sendToUsers(command, conversation, id);
						}
						else {
							sendError(ws, command, "Something went wrong. Try again.");
						}
					}
				}
				else {
					sendError(ws, command, "The domain provided isn't available to message.");
				}
			}
			break;

		case "MESSAGES":
			if (hasConversationReadAccess(body.conversation, ws.domain)) {
				if (body.before) {
					db("SELECT m.id, m.message, m.time, m.user, m.reactions, m.replying, p.message p_message, p.user p_user FROM messages m LEFT JOIN messages p ON p.id = m.replying WHERE m.conversation = ? AND m.ai < (SELECT ai FROM messages WHERE id = ?) ORDER BY m.ai DESC LIMIT 50", [body.conversation, body.before]).then(r => {
						sendMessages(ws, r, body);
					});
				}
				else if (body.at) {
					db("SELECT m.id, m.message, m.time, m.user, m.reactions, m.replying, p.message p_message, p.user p_user FROM messages m LEFT JOIN messages p ON p.id = m.replying WHERE m.conversation = ? AND m.ai >= (SELECT ai FROM messages WHERE id = ?) ORDER BY m.ai ASC LIMIT 50", [body.conversation, body.at]).then(r => {
						sendMessages(ws, r, body);
					});
				}
				else if (body.after) {
					db("SELECT id FROM messages WHERE conversation = ? ORDER BY ai DESC LIMIT 1", [body.conversation]).then(r => {
						if (r) {
							body.latestMessage = r[0].id;
						}
						db("SELECT m.id, m.message, m.time, m.user, m.reactions, m.replying, p.message p_message, p.user p_user FROM messages m LEFT JOIN messages p ON p.id = m.replying WHERE m.conversation = ? AND m.ai > (SELECT ai FROM messages WHERE id = ?) ORDER BY m.ai ASC LIMIT 50", [body.conversation, body.after]).then(r => {
							sendMessages(ws, r, body);
						});
					});
				}
				else {
					db("SELECT m.id, m.message, m.time, m.user, m.reactions, m.replying, p.message p_message, p.user p_user FROM messages m LEFT JOIN messages p ON p.id = m.replying WHERE m.conversation = ? ORDER BY m.ai DESC LIMIT 50", [body.conversation]).then(r => {
						sendMessages(ws, r, body);
					});
				}
			}
			else if (isChannel(body.conversation)) {
				let channelData = dataForChannel(body.conversation);
				let name = channelData.name;
				
				let data = {}

				if (channelData.registry) {
					var link;

					switch (channelData.registry) {
						case "varo":
							link = `https://varo.domains/tld/${name}`;
							break;

						case "namebase":
							link = `https://porkbun.com/tld/${name}`;
							break;

						case "impervious":
							link = `https://impervious.domains/tld/${encodeURIComponent(name)}`;
							break;

						case "ens":
							link = `https://ens.domains`;
							break;
					}

					data.link = link;
					data.resolution = "purchase";
				}
				else if (canCreateSLD(name)) {
					data.resolution = "create";
				}
				
				sendError(ws, command, "You don't have permission to access these messages.", data);
			}
			else {
				sendError(ws, command, "You don't have permission to access these messages.");
			}
			break;

		case "MESSAGE":
		case "NOTICE":
			delete typing[ws.domain];

			let message = body.message.trim();
			if (message.length) {
				let id = await generateID("message");
				let t = time();
				let user = ws.domain;
				let conversation = body.conversation;
				let replying = body.replying;
				let reply = Boolean(replying);

				let msgExists = await messageExists(replying);
				if (replying && !msgExists) {
					delete body.replying;
					replying = null;
					reply = 0;
				}

				if (hasConversationWriteAccess(conversation, user)) {
					if (command == "MESSAGE") {
						let c;
						if (isChannel(conversation)) {
							c = dataForChannel(conversation);
						}
						else {
							c = dataForPM(conversation);
						}
						c.activity = t;

						db("INSERT INTO messages (id, time, user, conversation, message, reply, replying) VALUES (?,?,?,?,?,?,?)", [id, t, user, conversation, message, reply, replying]);
						updateSeen(ws.session, conversation);
						sendToUsers(command, body, conversation, id, user, t);
						sendPushNotificationsIfNeeded(user, body);
					}
					else {
						sendToUser(body.notice, command, body, conversation, id, user, t);
					}
				}
			}
			break;

		case "REACT":
			let id = body.message;

			if (id.length) {
				let t = time();
				let user = ws.domain;
				let conversation = body.conversation;
				let reaction = body.reaction;

				if (hasConversationWriteAccess(conversation, user)) {
					db("SELECT reactions FROM messages WHERE id = ?", [id]).then(r => {
						let reactions = r[0]["reactions"];

						var json = JSON.parse(reactions);
						if (json[reaction]) {
							if (json[reaction].includes(user)) {
								json[reaction] = json[reaction].filter(u => {
									return u !== user
								});
							}
							else {
								json[reaction].push(user);
							}
						}
						else {
							json[reaction] = [user];
						}

						Object.keys(json).forEach((r, k) => {
							if (!json[r].length) {
								delete json[r];
							}
						});

						let object = {...json};
						let encoded = JSON.stringify(object);

						db("UPDATE messages SET reactions = ? WHERE id = ?", [encoded, id]);
						updateSeen(ws.session, conversation);
						sendToUsers(command, body, conversation, id, user, t);
					});
				}
			}
			break;

		case "DELETEMESSAGE":
			if (body.id) {
				db("SELECT * FROM messages WHERE id = ?", [body.id]).then(r => {
					let message = r[0];
					let conversation = message.conversation;

					if (isAdmin(conversation, ws)) {
						db("DELETE FROM messages WHERE id = ?", [body.id]);
						sendToUsers("DELETEMESSAGE", body, conversation);
					}
				});
			}
			break;

		case "PINMESSAGE":
			if (body.id) {
				db("SELECT * FROM messages WHERE id = ?", [body.id]).then(r => {
					let message = r[0];
					let conversation = message.conversation;

					if (isAdmin(conversation, ws)) {
						db("UPDATE channels SET pinned = ? WHERE id = ?", [body.id, conversation]);
						dataForChannel(conversation).pinned = body.id;
						sendToUsers("PINMESSAGE", body, conversation);
					}
				});
			}
			else if (body.conversation) {
				let conversation = body.conversation;
				if (isAdmin(conversation, ws)) {
					db("UPDATE channels SET pinned = ? WHERE id = ?", [null, conversation]);
					dataForChannel(conversation).pinned = null;
					sendToUsers("PINMESSAGE", body, conversation);
				}
			}
			break;

		case "MENTIONS":
			let mentions = [];
			db("SELECT seen FROM sessions WHERE id = ?", [ws.session]).then(s => {
				let oldest = 0;
				let seen = {};

				try {
					seen = JSON.parse(s[0].seen);
					let sorted = Object.entries(seen).sort((a, b) => {
						return a[1] - b[1];
					});
					oldest = sorted[0][1];
				}
				catch {}

				db("SELECT * FROM messages WHERE time > ? AND message LIKE ?", [oldest, `%@${ws.domain}%`]).then(r => {
					if (r) {
						r.forEach((m, k) => {
							if (isChannel(m.conversation) && hasConversationReadAccess(m.conversation, ws.domain)) {
								try {
									if (m.time > seen[m.conversation]) {
										mentions.push(m.conversation);
									}
								}
								catch {
									//console.log(m.conversation);
								};
							}
						});
					}
					sendMessage(ws, command, mentions);
				});
			});
			break;

		case "TYPING":
			typing[body.from] = { 
				to: body.to,
				time: Date.now()
			}
			break;

		case "GETADDRESS":
			user = dataForUser(body);
			tld = user.tld;
			domain = user.domain;

			var match;
			if (tld !== domain) {
				match = slds.filter(s => {
					return s.name == tld && s.hip2;
				});
			}

			let output = new Promise(resolve => {
				if (match && match.length) {
					db("SELECT * FROM domains WHERE id = ?", [user.id]).then(r => {
						if (r) {
							let address = r[0].address;
							if (address) {
								resolve(r);
							}
							resolve();
						}
						resolve();
					});
				}
				else {
					get(`https://${domain}/.well-known/wallets/HNS`, true).then(r => {
						if (r) {
							if (r.substring(0, 2) == "hs") {
								resolve(r);
							}
						}
						resolve();
					});
				}
			});

			let address = await output;
			if (address) {
				sendSuccess(ws, command, { address: address });
			}
			else {
				sendError(ws, command, "This user isn't currently accepting payments.");
			}
			break;

		case "CREATECHANNEL":
			if (body.name) {
				let name = body.name.toLowerCase();
				let id = await generateID("channel");
				let admins = JSON.stringify([body.user]);

				if (!validName(name)) {
					sendError(ws, command, "A channel name can only contain letters, numbers, and hyphens, but can't start or end with a hyphen.", { user: body.user });
					break;
				}

				if (dataForChannelByName(name)) {
					sendError(ws, command, "A channel name with this name already exists.", { user: body.user });
					break
				}

				let fee = `${config.channelPrice}.${getRndInteger(100000, 999999)}`;
				let insert = await db("INSERT INTO channels (id, name, public, tldadmin, admins, fee, created, hidden) VALUES (?,?,?,?,?,?,?,?)", [id, name, body.public, body.tldadmin, admins, fee, time(), 1]);
				if (!insert) {
					sendError(ws, command, "Something went wrong. Try again.", { user: body.user });
					break;
				}

				await makeVideoRoom(id, name);
				sendSuccess(ws, command, { user: body.user, id: id, fee: fee });
			}
			break;

		case "RECEIVEDPAYMENT":
			const regex = new RegExp("^(?:[a-z0-9]{64})$");
			if (!regex.test(body.tx)) {
				sendError(ws, command, "Something is wrong with that transaction.", { user: body.user });
				break;
			}

			let update = await db("UPDATE channels SET tx = ? WHERE id = ?", [body.tx, body.channel]);
			if (!update) {
				sendError(ws, command, "Something went wrong :/", { user: body.user });
				break;
			}

			sendSuccess(ws, command, { user: body.user });
			break;

		case "DELETEATTACHMENT":
			let exists = db("SELECT * FROM uploads WHERE id = ? AND session = ?", [body.id, ws.session]).then(r => {
				if (r.length) {
					let remove = db("DELETE FROM uploads WHERE id = ? AND session = ?", [body.id, ws.session]);
					if (remove) {
						fs.rmSync(`${config.path}/uploads/${body.id}`);
					}
				}
			});
			break;

		case "SAVEDSETTINGS":
			sendUser(ws.domain);
			break;

		case "SAVEPROFILE":
			if (body) {
				let update = await db("UPDATE domains SET bio = ? WHERE id = ?", [body.bio, ws.domain]);
				if (update) {
					sendUser(ws.domain);
				}
			}
			break;

		case "STARTVIDEO":
			if (isChannel(body.conversation) && !dataForChannel(body.conversation).video && isAdmin(body.conversation, ws)) {
				dataForChannel(body.conversation).video = true;
				dataForChannel(body.conversation).videoUsers[ws.domain] = { video: false, audio: false };
				dataForChannel(body.conversation).videoWatchers.push(ws.domain);
				body.users = dataForChannel(body.conversation).videoUsers;
				body.watchers = dataForChannel(body.conversation).videoWatchers;
				body.speakers = dataForChannel(body.conversation).videoSpeakers;
				sendToUsers(command, body, body.conversation);
			}
			break;

		case "INVITEVIDEO":
			if (isChannel(body.conversation) && dataForChannel(body.conversation).video && isAdmin(body.conversation, ws)) {
				if (!dataForChannel(body.conversation).videoSpeakers.includes(body.user)) {
					dataForChannel(body.conversation).videoSpeakers.push(body.user);
				}
				body.users = dataForChannel(body.conversation).videoUsers;
				body.watchers = dataForChannel(body.conversation).videoWatchers;
				body.speakers = dataForChannel(body.conversation).videoSpeakers;
				sendToUsers(command, body, body.conversation);
			}
			break;

		case "JOINVIDEO":
			if (isChannel(body.conversation) && dataForChannel(body.conversation).video && (isAdmin(body.conversation, ws) || dataForChannel(body.conversation).videoSpeakers.includes(ws.domain))) {
				if (!Object.keys(dataForChannel(body.conversation).videoUsers).includes(ws.domain)) {
					dataForChannel(body.conversation).videoUsers[ws.domain] = { video: false, audio: false };
				}
				if (!dataForChannel(body.conversation).videoWatchers.includes(ws.domain)) {
					dataForChannel(body.conversation).videoWatchers.push(ws.domain);
				}
				body.users = dataForChannel(body.conversation).videoUsers;
				body.watchers = dataForChannel(body.conversation).videoWatchers;
				body.speakers = dataForChannel(body.conversation).videoSpeakers;
				sendToUsers(command, body, body.conversation);
			}
			break;

		case "VIEWVIDEO":
			if (isChannel(body.conversation) && dataForChannel(body.conversation).video) {
				if (!dataForChannel(body.conversation).videoWatchers.includes(ws.domain)) {
					dataForChannel(body.conversation).videoWatchers.push(ws.domain);
					body.watchers = dataForChannel(body.conversation).videoWatchers;
					sendToUsers(command, body, body.conversation);
				}
			}
			break;

		case "LEAVEVIDEO":
			if (isChannel(body.conversation) && dataForChannel(body.conversation).video) {
				if (Object.keys(dataForChannel(body.conversation).videoUsers).includes(ws.domain)) {
					removeUserFromVideoUsers(dataForChannel(body.conversation), ws.domain);
				}
				else {
					removeUserFromVideoWatchers(dataForChannel(body.conversation), ws.domain);
				}
			}
			break;

		case "ENDVIDEO":
			if (isChannel(body.conversation) && dataForChannel(body.conversation).video && isAdmin(body.conversation, ws)) {
				dataForChannel(body.conversation).video = false;
				dataForChannel(body.conversation).videoUsers = {};
				dataForChannel(body.conversation).videoWatchers = [];
				dataForChannel(body.conversation).videoSpeakers = [];
				sendToUsers(command, body, body.conversation);
			}
			break;

		case "MUTEVIDEO":
			if (dataForChannel(body.conversation).videoUsers[ws.domain]) {
				let video = dataForChannel(body.conversation).videoUsers[ws.domain].video;
				dataForChannel(body.conversation).videoUsers[ws.domain].video = !video;
				body.user = ws.domain;
				sendToUsers(command, body, body.conversation);
			}
			break;

		case "MUTEAUDIO":
			if (dataForChannel(body.conversation).videoUsers[ws.domain]) {
				let audio = dataForChannel(body.conversation).videoUsers[ws.domain].audio;
				dataForChannel(body.conversation).videoUsers[ws.domain].audio = !audio;
				body.user = ws.domain;
				sendToUsers(command, body, body.conversation);
			}
			break;

		case "CHANGEDCONVERSATION":
			updateSeen(ws.session, body);
			break;
	}
}

function updateSeen(session, conversation) {
	if (conversationExists(conversation)) {
			db(`UPDATE sessions SET seen = JSON_MERGE_PATCH(seen, '{"${conversation}":${time()}}') WHERE id = ?`, [session]);
		}
}

function conversationExists(id) {
	if (dataForChannel(id) || dataForPM(id)) {
		return true;
	}
	return false;
}

async function messageExists(id) {
	let output = new Promise(resolve => {
		db("SELECT * FROM messages WHERE id = ?", [id]).then(r => {
			if (r[0]) {
				log("message exists");
				resolve(true);
			}
			log("message doesn't exist");
			resolve(false);
		});
	});
	return await output;
}

function removeUserFromVideoChatsIfNeeded(user) {
	channels.forEach((c, k) => {
		if (Object.keys(c.videoUsers).includes(user)) {
			removeUserFromVideoUsers(c, user);
		}
		if (c.videoWatchers.includes(user)) {
			removeUserFromVideoWatchers(c, user);
		}
	});
}

function removeUserFromVideoUsers(channel, user) {
	delete channel.videoUsers[user];

	if (!Object.keys(channel.videoUsers).length) {
		channel.video = false;
		channel.videoWatchers = [];
		channel.videoSpeakers = [];

		let body = {
			conversation: channel.id
		}
		sendToUsers("ENDVIDEO", body, channel.id);
	}
	else {
		let body = {
			conversation: channel.id,
			users: channel.videoUsers
		}
		sendToUsers("LEAVEVIDEO", body, channel.id);
	}
}

function removeUserFromVideoWatchers(channel, user) {
	channel.videoWatchers = channel.videoWatchers.filter(u => {
		return u !== user;
	});

	let body = {
		conversation: channel.id,
		watchers: channel.videoWatchers
	}
	sendToUsers("LEAVEVIDEO", body, channel.id);
}

function isAdmin(conversation, ws) {
	if (isChannel(conversation)) {
		let channel = dataForChannel(conversation);
		let admins = JSON.parse(channel.admins);
		let me = dataForUser(ws.domain);

		if ((channel.tldadmin && channel.name == me.domain) || me.admin || admins.includes(ws.domain)) {
			return true;
		}
	}
	return false;
}

function regex(pattern, string) {
	return [...string.matchAll(pattern)];
}

function otherUser(users, not) {
	return users.filter(u => {
		return u !== not;
	})[0];
}

async function sendPushNotificationsIfNeeded(user, body) {
	let notifications = [];

	let msg = body.message;
	let name,message;
	let active = activeUsers();
	
	try {
		message = JSON.parse(msg).message;
	}
	catch {
		message = msg;
	}

	if (typeof message != "string") {
		return;
	}

	if (message && message.length) {
		if (isChannel(body.conversation)) {
			name = dataForChannel(body.conversation).name;

			let mentions = new Promise(resolve => {
				let users = usersInMessage(message);
				users.forEach((u, k) => {
					if (hasConversationReadAccess(body.conversation, u.groups.id) && !active.includes(u.groups.id)) {
						let push = pushForUser(u.groups.id);
						if (push.length) {
							push.forEach((p, k) => {
								notifications[p] = {
									user: u.groups.id,
									title: `Mention in #${name}`,
									body: `@${user}: ${message}`
								};
							});
						}
					}
				});
				resolve();
			});
			
			let reply = new Promise(resolve => {
				if (body.replying) {
					db("SELECT user FROM messages WHERE id = ?", [body.replying]).then(r => {
						if (r[0]) {
							let sender = r[0].user;
							if (!active.includes(sender)) {
								let push = pushForUser(sender);
								if (push.length) {
									push.forEach((p, k) => {
										notifications[p] = {
											user: sender,
											title: `Reply in #${name}`,
											body: `@${user}: ${message}`
										};
									});
								}
							}
						}
						resolve();
					});
				}
				else {
					resolve();
				}
			});

			await mentions;
			await reply;
		}
		else {
			let pmData = dataForPM(body.conversation);
			let me = otherUser(JSON.parse(pmData.users), user);

			let pm = new Promise(resolve => {
				if (!active.includes(me)) {
					let push = pushForUser(me);
					if (push.length) {
						push.forEach((p, k) => {
							notifications[p] = {
								user: me,
								title: `Private Message from @${user}`,
								body: "Encrypted message"
							};
						});
					}
				}
				resolve();
			});
			await pm;
		}

		Object.keys(notifications).forEach((p, k) => {
			let n = notifications[p];
			sendPushNotification(p, n.user, body.conversation, n.title, n.body);
		});
	}
}

function sendPushNotification(token, domain, conversation, title, body) {
	title = replaceIds(title).replace("@", "").replace("\x00", "");
	body = replaceIds(body);

	let data = {
		title: title,
		body: body,
		data: {
			domain: domain,
			conversation: conversation
		}
	};
	sendNotification(token, data);
}

async function sendNotification(expoPushToken, data) {
    const expo = new Expo({ accessToken: config.expoKey });

    const chunks = expo.chunkPushNotifications([{ to: expoPushToken, ...data }]);
    const tickets = [];

    for (const chunk of chunks) {
        try {
            const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
            tickets.push(...ticketChunk);
        } catch (error) {
            console.error(error);
        }
    }

    let response = "";

    for (const ticket of tickets) {
        if (ticket.status === "error") {
            if (ticket.details && ticket.details.error === "DeviceNotRegistered") {
                response = "DeviceNotRegistered";
            }
        }

        if (ticket.status === "ok") {
            response = ticket.id;
        }
    }

    return response;
}

function usersInMessage(message) {
	let matches = regex(/\@(?<id>[a-zA-Z0-9]{16}(?:\b|$))/gm, message);
	return matches;
}

function channelsInMessage(message) {
	let matches = regex(/\@(?<id>[a-zA-Z0-9]{8}(?:\b|$))/gm, message);
	return matches;
}

function replaceIds(message, link=false) {
	let output = message;

	while (channelsInMessage(output).length) {
		let channels = channelsInMessage(output);
		let result = channels[0];

		let id = result.groups.id;
		let start = result.index;
		let end = (start + id.length + 1);
		
		let replace;
		let match = dataForChannel(id);
		if (match) {
			let channel = match.name;
			replace = `@\x00${toUnicode(channel)}`;
		}
		else {
			replace = `@\x00${id}`;
		}
		output = replaceRange(output, start, end, replace);
	}

	while (usersInMessage(output).length) {
		let users = usersInMessage(output);
		let result = users[0];

		let id = result.groups.id;
		let start = result.index;
		let end = (start + id.length + 1);

		let replace;
		let match = dataForUser(id);
		if (match) {
			let domain = match.domain;
			replace = `@\x00${toUnicode(domain)}/`;
		}
		else {
			replace = `@\x00${id}`;
		}
		output = replaceRange(output, start, end, replace);
	}
	return output;
}

function replaceRange(s, start, end, substitute) {
	let before = s.substr(0, start);
	let after = s.substr(end, (s.length -end));

	return before+substitute+after;
}

function getRndInteger(min, max) {
	return Math.floor(Math.random() * (max - min) ) + min;
}

function toUnicode(name) {
	let puny = punycode.toUnicode(name);
	let zwj = nameToUnicode(puny);
	return zwj;
}

function sendUser(id) {
	db(`SELECT ${userColumns} FROM domains d LEFT JOIN sessions s ON s.id = d.session WHERE d.id = ?`, [id]).then(r => {
		if (r.length) {
			users = users.filter(u => {
				return u.id !== id;
			});
			users.push(r[0]);
			sendToAllClients("USER", r[0]);
		}
	});
}

async function lockAndSendOthers(name, id) {
	let others = await db("SELECT * FROM domains WHERE domain = ? AND id != ? AND locked = 0", [name, id]);
	let update = await db("UPDATE domains SET locked = 1 WHERE domain = ? AND locked = 0 AND id != ?", [name, id]);

	if (update) {
		others.forEach((d, k) => {
			sendUser(d.id);
		});
	}

	return;
}

async function addDomain(ws, name, type) {
	let id = await generateID("domain");
	name = name.toLowerCase();

	let exists = await db("SELECT * FROM domains WHERE domain = ? AND session = ? AND deleted = 0 AND type = ?", [name, ws.session, type]);
	if (exists.length) {
		return false;
	}

	let insert = await db("INSERT INTO domains (id, domain, type, session, created) VALUES (?,?,?,?,?)", [id, name, type, ws.session, time()]);
	if (insert) {
		await lockAndSendOthers(name, id);
		sendUser(id);
		return id;
	}
	return false;
}

async function unlockDomain(id, name) {
	let unlock = await db("UPDATE domains SET locked = 0 WHERE id = ?", [id]);
	if (unlock) {
		await lockAndSendOthers(name, id);
		sendUser(id);
		
		return true;
	}
	return false;
}

function validName(name) {
	try {
		return name.match(/^(?:[A-Za-z0-9][A-Za-z0-9\-]{0,61}[A-Za-z0-9]|[A-Za-z0-9])$/g).length;
	}
	catch {}
	return false;
}

function isAvailableSLD(tld, sld) {
	return !users.filter(d => {
		return d.tld == tld && d.domain == `${sld}.${tld}`;
	}).length;
}

function tldForDomain(domain) {
	let split = domain.split(".");
	return split.pop();
}

function canCreateSLD(tld) {
	return slds.filter(t => { return t.name == tld; }).length;
}

function hasConversationReadAccess(conversation, user) {
	var c;
	if (isChannel(conversation)) {
		c = dataForChannel(conversation);
	}
	else {
		c = dataForPM(conversation);
	}

	if (!c) {
		return;
	}

	let data = dataForUser(user);
	if (data.deleted) {
		return false;
	}

	let users = usersForConversation(conversation);
	return users.filter(u => {
		return u.id == user;
	}).length;
}

function hasConversationWriteAccess(channel, user) {
	let data = dataForUser(user);
	if (data.locked || data.deleted) {
		return false;
	}

	let users = usersForConversation(channel);
	return users.filter(u => {
		return u.id == user;
	}).length;
}

function isChannel(id) {
	if (id.toString().length == 8) {
		if (dataForChannel(id)) {
			return true;
		}
	}
	return false;
}

function dataForChannel(id) {
	return channels.filter(a => {
		return a.id == id;
	})[0];
}

function dataForChannelByName(name) {
	return channels.filter(a => {
		return a.name == name;
	})[0];
}

function dataForPM(id) {
	return pms.filter(a => {
		return a.id == id;
	})[0];
}

function dataForUser(id) {
	return users.filter(a => {
		return a.id == id;
	})[0];
}

function pushForUser(id) {
	return JSON.parse(sessions.filter(a => {
		return a.domain == id;
	})[0].push);
}

function dataForDomain(domain) {
	return users.filter(a => {
		return a.domain == domain && !a.locked && !a.deleted;
	})[0];
}

function getStaked() {
	var output = [];

	channels.forEach(c => {
		if (c.slds) {
			let data = {
				name: c.name,
				hip2: c.hip2
			}
			output.push(data);
		}
	});

	let sorted = output.sort((a, b) => {
		return a.name.localeCompare(b.name);
	});

	return sorted;
}

function usersForConversation(id) {
	var output = [];

	if (isChannel(id)) {
		let channelInfo = dataForChannel(id);
		if (channelInfo.public) {
			output = users;
		}
		else {
			let tld = channelInfo.name;
			output = users.filter(u => {
				return u.tld == tld || config.admin.includes(u.id);
			});
		}
	}
	else {
		let pmInfo = dataForPM(id);
		let pmUsers = JSON.parse(pmInfo.users);

		pmUsers.forEach(u => {
			output.push(dataForUser(u));
		});
	}

	return output;
}

function clientsForUsers(users) {
	var output = [];

	let clients = wss.clients;
	clients.forEach(c => {
		let client = users.filter(c2 => {
			return c2.id == c.domain;
		})[0];

		if (client) {
			output.push(c);
		}
	});

	return output;
}

function sendToUsers(type, body, conversation, id=null, user=null, time=null) {
	let conversationUsers = usersForConversation(conversation);
	let clients = clientsForUsers(conversationUsers);

	var message;
	clients.forEach(client => {
		switch (type) {
			case "MESSAGE":
				message = {
					conversation: conversation,
					id: id,
					message: body.message.toString(),
					time: time,
					user: user
				}

				if (body.replying) {
					message.replying = body.replying;
					db("SELECT * FROM messages WHERE id = ?", [body.replying]).then(r => {
						let replying = r[0];
						if (replying) {
							message.p_message = replying.message;
							message.p_user = replying.user;
						}
						else {
							delete message.replying;
						}
						sendMessage(client, type, message);
					});
				}
				else {
					sendMessage(client, type, message);
				}
				break;

			case "REACT":
				message = {
					conversation: conversation,
					message: id,
					user: user,
					reaction: body.reaction
				}
				sendMessage(client, type, message);
				break;

			case "TYPING":
				if (client.domain !== body.from) {
					sendMessage(client, type, body);
				}
				break;

			default:
				sendMessage(client, type, body);
				break;
		}
	});
}

function sendToUser(to, type, body, conversation, id=null, user=null, time=null) {
	let conversationUsers = [dataForUser(to)];
	let clients = clientsForUsers(conversationUsers);

	var message;
	clients.forEach(client => {
		switch (type) {
			case "NOTICE":
				message = {
					conversation: conversation,
					id: id,
					message: body.message,
					time: time,
					user: user
				}

				if (body.replying) {
					message.replying = body.replying;
					db("SELECT * FROM messages WHERE id = ?", [body.replying]).then(r => {
						let replying = r[0];
						message.p_message = replying.message;
						message.p_user = replying.user;
						sendMessage(client, type, message);
					});
				}
				else {
					sendMessage(client, type, message);
				}
				break;
		}
	});
}

function activeUsers() {
	let users = [];
	wss.clients.forEach(client => {
		if (client.domain) {
			if (!users.includes(client.domain)) {
				users.push(client.domain);
			}
		}
	});
	return users;
}

function sendToAllClients(type, message) {
	wss.clients.forEach(client => {
		if (client.domain) {
			let data = message;

			if (typeof data == "object") {
				data = JSON.stringify(data);
			}
			client.send(`${type} ${data}`);
		}
	});
}

function sendMessage(ws, type, message) {
	let data = `${type}`;
	if (message) {
		if (typeof message == "object") {
			data += ` ${JSON.stringify(message)}`;
		}
		else {
			data += ` ${message}`;
		}
	}

	let user = dataForUser(ws.domain);
	if (user) {
		log(`OUT [${user.domain}]: ${data}`);
	}
	else {
		log(`OUT [${ws.ip}]: ${data}`);
	}

	ws.send(data);
}

function sendMessages(ws, messages, body) {
	var output = {
		messages: []
	};

	output.messages = messages;

	if (body) {
		if (body.before) {
			output.before = true;
		}
		else if (body.at) {
			output.at = body.at;
		}
		else if (body.after) {
			output.after = true;
			output.latestMessage = body.latestMessage;
		}
		
		if (!body.before && !body.after) {
			output.messages = output.messages.reverse();
		}

		let data = `MESSAGES ${JSON.stringify(output)}`;
		log(`OUT: ${data}`);
		ws.send(data);
	}
}

async function currentVersion() {
	let output = new Promise(resolve => {
		fs.readFile(`${config.path}/.git/refs/heads/master`, 'utf8', (err, data) => {
			resolve(data.trim());
		});
	})
	return await output;
}

function nameToUnicode(unicode) {
    const skinColors = ["🏻", "🏼", "🏽", "🏾", "🏿"];
    const tonedEmojis = [
        "❤",
        "💋",
        "😶",
        "😮",
        "😵",
        "👶",
        "🧒",
        "👦",
        "👧",
        "🧑",
        "👱",
        "👨",
        "🧔",
        "👨‍🦰",
        "👨‍🦱",
        "👨‍🦳",
        "👨‍🦲",
        "👩",
        "👩‍🦰",
        "🧑‍🦰",
        "👩‍🦱",
        "🧑‍🦱",
        "👩‍🦳",
        "🧑‍🦳",
        "👩‍🦲",
        "🧑‍🦲",
        "🧓",
        "👴",
        "👵",
        "🙍",
        "🙎",
        "🙅",
        "🙆",
        "💁",
        "🙋",
        "🧏",
        "🙇",
        "🤦",
        "🤷",
        "🧑‍🎓",
        "👨‍🎓",
        "👩‍🎓",
        "🧑‍🏫",
        "👨‍🏫",
        "👩‍🏫",
        "🧑‍🌾",
        "👨‍🌾",
        "👩‍🌾",
        "🧑‍🍳",
        "👨‍🍳",
        "👩‍🍳",
        "🧑‍🔧",
        "👨‍🔧",
        "👩‍🔧",
        "🧑‍🏭",
        "👨‍🏭",
        "👩‍🏭",
        "🧑‍💼",
        "👨‍💼",
        "👩‍💼",
        "🧑‍🔬",
        "👨‍🔬",
        "👩‍🔬",
        "🧑‍💻",
        "👨‍💻",
        "👩‍💻",
        "🧑‍🎤",
        "👨‍🎤",
        "👩‍🎤",
        "🧑‍🎨",
        "👨‍🎨",
        "👩‍🎨",
        "🧑‍✈",
        "👨‍✈",
        "👩‍✈",
        "🧑‍🚀",
        "👨‍🚀",
        "👩‍🚀",
        "🧑‍🚒",
        "👨‍🚒",
        "👩‍🚒",
        "👮",
        "🕵",
        "💂",
        "🥷",
        "👷",
        "🤴",
        "👸",
        "👳",
        "👲",
        "🧕",
        "🤵",
        "👰",
        "🤰",
        "🤱",
        "👩‍🍼",
        "👨‍🍼",
        "🧑‍🍼",
        "👼",
        "🎅",
        "🤶",
        "🧑‍🎄",
        "🦸",
        "🦹",
        "🧙",
        "🧚",
        "🧛",
        "🧜",
        "🧝",
        "🧞",
        "🧟",
        "💆",
        "💇",
        "🫅",
        "🫃",
        "🫄",
        "🚶",
        "🧍",
        "🧎",
        "🧑‍🦯",
        "👨‍🦯",
        "👩‍🦯",
        "🧑‍🦼",
        "👨‍🦼",
        "👩‍🦼",
        "🧑‍🦽",
        "👨‍🦽",
        "👩‍🦽",
        "🏃",
        "💃",
        "🕺",
        "👯",
        "🧖",
        "🧘",
        "🧑‍🤝‍🧑",
        "👭",
        "👫",
        "👬",
        "💏",
        "👩‍❤️‍💋‍👨",
        "👨‍❤️‍💋‍👨",
        "👩‍❤️‍💋‍👩",
        "💑",
        "👩‍❤️‍👨",
        "👨‍❤️‍👨",
        "👩‍❤️‍👩",
        "👪",
        "👨‍👩‍👦",
        "👨‍👩‍👧",
        "👨‍👩‍👧‍👦",
        "👨‍👩‍👦‍👦",
        "👨‍👩‍👧‍👧",
        "👨‍👨‍👦",
        "👨‍👨‍👧",
        "👨‍👨‍👧‍👦",
        "👨‍👨‍👦‍👦",
        "👨‍👨‍👧‍👧",
        "👩‍👩‍👦",
        "👩‍👩‍👧",
        "👩‍👩‍👧‍👦",
        "👩‍👩‍👦‍👦",
        "👩‍👩‍👧‍👧",
        "👨‍👦",
        "👨‍👦‍👦",
        "👨‍👧",
        "👨‍👧‍👦",
        "👨‍👧‍👧",
        "👩‍👦",
        "👩‍👦‍👦",
        "👩‍👧",
        "👩‍👧‍👦",
        "👩‍👧‍👧",
        "🕴",
        "🧗",
        "🧗",
        "🧗",
        "🤺",
        "🏇",
        "⛷",
        "🏂",
        "🏌",
        "🏄",
        "🚣",
        "🏊",
        "⛹",
        "🏋",
        "🚴",
        "🚵",
        "🤸",
        "🤼",
        "🤽",
        "🤾",
        "🤹",
        "🧘",
        "👋",
        "🤚",
        "🖐",
        "✋",
        "🫱",
        "🫲",
        "🫳",
        "🫴",
        "🫰",
        "🫵",
        "🫶",
        "🖖",
        "👌",
        "🤌",
        "🤏",
        "✌",
        "🤞",
        "🤟",
        "🤘",
        "🤙",
        "👈",
        "👉",
        "👆",
        "🖕",
        "👇",
        "☝",
        "👍",
        "👎",
        "✊",
        "👊",
        "🤛",
        "🤜",
        "👏",
        "🙌",
        "👐",
        "🤲",
        "🤝",
        "🙏",
        "✍",
        "💅",
        "🤳",
        "💪",
        "🦵",
        "🦶",
        "👂",
        "🦻",
        "👃",
        "🛌",
        "🛀",
        "🏳",
        "🏴",
        "👁",
        "🐈",
        "🐦",
        "🐕",
        "🦺",
        "🐻"
    ];

    const allChars = tonedEmojis.concat(skinColors);
    let chars = [];
    let i = 0;

    for (let c of unicode) {
        // remove last zwj if the next one is a skin color
        if (skinColors.includes(c)) chars.pop();

        // add emoji
        chars.push(c);

        // add zwj
        if (allChars.includes(c)) chars.push("\u200d");

        i++;
    }

    // remove last element if zwj
    if (chars[chars.length - 1] === "\u200d") chars.pop();

    // combine to string
    return chars.join("");
}

init();
