const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SALT_PREFIX = 'nightwatch_v2_';
const BLOCKED_USERS = ['thiagoz.p', 'vollsec'];
const BLOCKED_PROFILE_DIRS = ['gemeos.lemiska'];

function parseCredentials(filepath) {
    const content = fs.readFileSync(filepath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const credentials = {};
    lines.forEach(line => {
        const match = line.match(/^(\w+)\s*\/\s*([^\(]+)\s*\((\w+)\)\s*$/);
        if (match) {
            credentials[match[1]] = {
                username: match[1],
                password: match[2].trim(),
                role: match[3]
            };
        }
    });
    return credentials;
}

function processEvent(event, users) {
    if (!event.user?.uid) return;
    const u = event.user;
    const uid = u.uid;
    if (BLOCKED_USERS.includes(u.uniqueId)) return;

    if (!users.has(uid)) {
        users.set(uid, {
            uid,
            unique_id: u.uniqueId,
            nickname: u.nickname || 'Unknown',
            profile_picture: u.profilePicture?.urls?.[0] || null,
            is_moderator: !!u.isModerator,
            is_subscriber: !!u.isSubscriber,
            user_level: u.userLevel || 0,
            gifter_level: u.gifterLevel || 0,
            interactions: { comments: [], gifts: [], likes: [], joins: [] },
            stats: {
                total_comments: 0,
                total_gifts: 0,
                total_likes: 0,
                total_joins: 0,
                unique_comment_count: 0
            }
        });
    }

    const user = users.get(uid);

    switch (event.type) {
        case 'comment': {
            user.stats.total_comments++;
            const text = event.comment || event.data?.comment;
            if (text) {
                const existing = user.interactions.comments.find(c => c.text === text);
                if (existing) { existing.count++; existing.last_at = event.timestamp; }
                else user.interactions.comments.push({ text, count: 1, first_at: event.timestamp, last_at: event.timestamp });
            }
            break;
        }
        case 'gift': {
            const giftCount = event.gift?.repeatCount || 1;
            user.stats.total_gifts += giftCount;
            user.interactions.gifts.push({ name: event.gift?.name || 'Unknown', count: giftCount, diamonds: event.gift?.diamondCount || 0, at: event.timestamp });
            break;
        }
        case 'like': {
            const likeCount = event.likeCount || 1;
            user.stats.total_likes += likeCount;
            user.interactions.likes.push({ count: likeCount, at: event.timestamp });
            break;
        }
        case 'join': {
            user.stats.total_joins++;
            user.interactions.joins.push({ at: event.timestamp });
            break;
        }
    }
}

function finalizeUsers(users) {
    users.forEach(user => {
        user.stats.unique_comment_count = user.interactions.comments.length;
        user.interactions.comments.sort((a, b) => b.count - a.count);
        user.interactions.gifts.sort((a, b) => b.count - a.count);
    });
    return { users: Array.from(users.values()) };
}

function encryptData(data, password, username) {
    const salt = `${SALT_PREFIX}${username}`;
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return {
        version: '2.0',
        algorithm: 'AES-256-GCM',
        user: username,
        salt: salt,
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        data: encrypted,
        created: Date.now()
    };
}

function updateIndexHtml(indexPath, credentials) {
    let content = fs.readFileSync(indexPath, 'utf8');

    const userDbEntries = Object.values(credentials).map(cred => {
        const hash = crypto.createHash('sha256').update(cred.password).digest('hex');
        return `    '${cred.username}': {\n        // ${cred.username} / ${cred.password}\n        hash: '${hash}',\n        role: '${cred.role}',\n        file: 'users_${cred.username}.enc',\n        file_v2: 'users_${cred.username}_v2.enc'\n    }`;
    });

    const userDbString = 'const USER_DB = {\n' + userDbEntries.join(',\n') + '\n};';
    const userDbRegex = /const USER_DB = \{[\s\S]*?\};/;
    if (userDbRegex.test(content)) {
        content = content.replace(userDbRegex, userDbString);
    } else {
        console.error('Could not find USER_DB in index.html');
        return false;
    }

    fs.writeFileSync(indexPath, content);
    return true;
}

async function main() {
    console.log('NightWatch Encryption Tool — V2 dataset\n');

    const baseDir           = process.cwd();
    const credentialsPath   = path.join(baseDir, 'credentials.txt');
    // V2: lê consolidated_v2.jsonl (gerado a partir de data_v2/)
    const consolidatedPath  = path.join(baseDir, 'consolidated_v2.jsonl');
    const dataDir           = path.join(baseDir, 'data');
    const indexPath         = path.join(baseDir, 'index.html');

    if (!fs.existsSync(credentialsPath)) { console.error('Error: credentials.txt not found'); process.exit(1); }
    if (!fs.existsSync(consolidatedPath)) { console.error('Error: consolidated_v2.jsonl not found\n  Gere com: cat data_v2/*/events.jsonl > consolidated_v2.jsonl'); process.exit(1); }

    console.log('Reading credentials...');
    const credentials = parseCredentials(credentialsPath);
    if (Object.keys(credentials).length === 0) { console.error('Error: No valid credentials found'); process.exit(1); }

    console.log(`Found ${Object.keys(credentials).length} users:`);
    Object.values(credentials).forEach(c => console.log(`  - ${c.username} (${c.role})`));

    console.log('\nLoading consolidated_v2.jsonl...');
    const users = new Map();
    let lineCount = 0, errorCount = 0;

    await new Promise((resolve, reject) => {
        const rl = readline.createInterface({ input: fs.createReadStream(consolidatedPath), crlfDelay: Infinity });
        rl.on('line', (line) => {
            if (!line.trim()) return;
            try { processEvent(JSON.parse(line), users); lineCount++; }
            catch (err) { errorCount++; }
        });
        rl.on('close', resolve);
        rl.on('error', reject);
    });

    if (errorCount > 0) console.log(`  Linhas inválidas: ${errorCount}`);

    const processed = finalizeUsers(users);
    console.log(`\nProcessed ${processed.users.length} unique users from ${lineCount} events`);
    console.log(`  Comments: ${processed.users.reduce((a, u) => a + u.stats.total_comments, 0)}`);
    console.log(`  Gifts:    ${processed.users.reduce((a, u) => a + u.stats.total_gifts, 0)}`);
    console.log(`  Likes:    ${processed.users.reduce((a, u) => a + u.stats.total_likes, 0)}`);

    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    // Remove apenas os _v2.enc antigos, não toca nos v1
    console.log('\nCleaning old v2 encrypted files...');
    fs.readdirSync(dataDir).filter(f => f.endsWith('_v2.enc')).forEach(f => {
        fs.unlinkSync(path.join(dataDir, f));
        console.log(`  Removed: ${f}`);
    });

    console.log('\nEncrypting v2 data...');
    Object.values(credentials).forEach(cred => {
        const encrypted = encryptData(processed, cred.password, cred.username);
        const filename  = `users_${cred.username}_v2.enc`;
        fs.writeFileSync(path.join(dataDir, filename), JSON.stringify(encrypted, null, 2));
        console.log(`  Created: ${filename}`);
    });

    console.log('\nUpdating index.html (adding file_v2 to USER_DB)...');
    if (updateIndexHtml(indexPath, credentials)) {
        console.log('  index.html updated successfully');
    } else {
        console.error('  Failed to update index.html');
    }

    console.log('\n' + '='.repeat(50));
    console.log('Done!');
    console.log('='.repeat(50));
    console.log('  data/*_v2.enc  — novos dados criptografados');
    console.log('  data/*.enc     — dados antigos INTACTOS');
    console.log('\nDeploy:');
    console.log('  git add . && git commit -m "Add v2 dataset" && git push');
    console.log('='.repeat(50) + '\n');
}

main();

