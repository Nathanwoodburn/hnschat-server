const readline = require('readline');
const mysql = require('mysql');

const config = require("./config.json");
const { exit } = require('process');

const sql = mysql.createPool({
	host: config.sqlHost,
	user: config.sqlUser,
	password: config.sqlPass,
	database: config.sqlDatabase,
	charset : "utf8mb4"
});

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

async function db(query, values=[]) {
	let result = new Promise(resolve => {
		sql.query(query, values, (e, r, f) => {
			try {
				resolve(JSON.parse(JSON.stringify(r)));
			}
			catch {
				console.log(e);
			}
		});
	});
	return await result;
}

function time() {
	return Math.floor(Date.now() / 1000);
}
function validName(name) {
	try {
		return name.match(/^(?:[A-Za-z0-9][A-Za-z0-9\-]{0,61}[A-Za-z0-9]|[A-Za-z0-9])$/g).length;
	}
	catch {}
	return false;
}
const makeID = (length) => {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
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

rl.question('Enter channel name: ', async (channelName) => {
	rl.question('Enter admin domains (comma separated): ', async (adminNames) => {
		if (!validName(channelName)) {
			console.log("Invalid channel name. A channel name can only contain letters, numbers, and hyphens, but can't start or end with a hyphen.");
			rl.close();
			exit(1);
		}

		let id = await generateID("channel");
        var adminNames = adminNames.split(",");

        var admins = [];
        for (var i = 0; i < adminNames.length; i++) {
            let adminID = await db("SELECT id FROM domains WHERE domain = ?", [adminNames[i].trim()]);
            if (!adminID.length) {
                console.log("Admin domain not found.");
                rl.close();
                exit(1);
            }
            admins.push(adminID[0].id);
        }
        admins = JSON.stringify(admins);
        console.log(`Creating channel with admin IDs: ${admins}`);

		let fee = `${config.channelPrice}.${Math.floor(Math.random() * (999999 - 100000 + 1)) + 100000}`;
		let insert = await db("INSERT INTO channels (id, name, public, tldadmin, admins, fee, created, hidden, activated) VALUES (?,?,?,?,?,?,?,?,?)", [id, channelName, true, false, admins, fee, time(), 0, 1]);
		if (!insert) {
			console.log("Something went wrong. Try again.");
			rl.close();
			exit(1);
		}

		console.log(`Channel created successfully with ID: ${id}`);
		rl.close();
		exit(0);
	});
});
