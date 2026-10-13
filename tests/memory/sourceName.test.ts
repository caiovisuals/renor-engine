import { describe, it, expect } from 'vitest';
import { cleanSource, headerSource, productFromUserAgent, MAX_SOURCE_LENGTH } from '../../src/memory/sourceName';

/**
 * The name a write stores for the `source` a client sent (memory/sourceName.ts). An agent that builds its call by hand
 * sometimes sends a file path or a URL where a name belongs; a daily-note header then ran it together into one word
 * (`/home/ana/atlas/BOARD.md` became `homeanaatlasBOARDmd`) and the ledger kept it whole. Synthetic names only.
 */

describe('cleanSource: a source that is already a name is left as it was sent', () => {
  // None of these has a `/` or `\` or more than 40 characters.
  const NAMES = [
    'claude', 'cursor', 'chatgpt', 'executor-3', 'Claude Code', 'mcp:remember', 'import:markdown', 'Builder round 3',
    'claude.ai', 'gpt-4.1', 'node.js', 'BOARD.md', 'São Paulo', '日本語', 'a', '!!!', '~', '.', '...', 'x'.repeat(MAX_SOURCE_LENGTH),
  ];

  it.each(NAMES)('%s', (name) => {
    expect(cleanSource(name)).toBe(name);
  });

  it('loses only the blanks around it', () => {
    expect(cleanSource('  claude  ')).toBe('claude');
    expect(cleanSource('\tClaude Code\n')).toBe('Claude Code');
  });

  it('is empty when nothing is left, which names no one', () => {
    for (const blank of ['', '   ', '\t\n', '\u00a0']) expect(cleanSource(blank), JSON.stringify(blank)).toBe('');
  });
});

describe('cleanSource: a path is reduced to the name it ends in', () => {
  const CASES: Array<[string, string, string]> = [
    // [what was sent, what is stored, why]
    ['/home/ana/atlas/BOARD.md', 'BOARD.md', 'an absolute path'],
    ['~/.claude/projects/-home-ana-atlas/memory/t8.md', 't8.md', 'a home path through a hidden directory'],
    ['./docs/PLAN.md', 'PLAN.md', 'a relative path'],
    ['../notes/log.txt', 'log.txt', 'a path that starts above'],
    ['docs/PLAN.md', 'PLAN.md', 'a relative path with no dot in front'],
    ['C:\\Users\\ana\\atlas\\BOARD.md', 'BOARD.md', 'a Windows path'],
    ['C:/Users/ana/atlas/BOARD.md', 'BOARD.md', 'a Windows path with forward slashes'],
    ['\\\\server\\share\\notes.json', 'notes.json', 'a network share'],
    ['atlas/sub\\BOARD.md', 'BOARD.md', 'both separators in one path'],
    ['/home/ana/atlas', 'atlas', 'a directory'],
    ['/home/ana/atlas/', 'atlas', 'a trailing separator'],
    ['/home/ana/atlas//', 'atlas', 'doubled trailing separators'],
    ['/home/ana/.claude', '.claude', 'a hidden directory'],
    ['/home/ana/..', 'ana', '`..` names nothing'],
    ['/home/ana/./', 'ana', '`.` names nothing'],
    ['/home/ana/  /', 'ana', 'a blank component names nothing'],
    ['/home/example/ Ana /x.md', 'x.md', 'blanks around a component'],
    ['crew/executor-7', 'executor-7', 'a label with a slash is a location: its last part is the name'],
    ['/Users/ana/My Notes/Plan v2.md', 'Plan v2.md', 'spaces inside the name stay'],
    ['/Users/ana/Documentos/Lição de casa.md', 'Lição de casa.md', 'letters of any script stay'],
    ['/', '', 'nothing is named'],
    ['///', '', 'nothing is named'],
    ['\\\\', '', 'nothing is named'],
    ['./', '', 'nothing is named'],
    ['../', '', 'nothing is named'],
  ];

  it.each(CASES)('%s -> %s (%s)', (sent, stored) => {
    expect(cleanSource(sent)).toBe(stored);
  });

  it('keeps nothing of the directories it came through', () => {
    const stored = cleanSource('/home/ana/secret-client/atlas/BOARD.md');
    expect(stored).toBe('BOARD.md');
    expect(stored).not.toMatch(/home|ana|client|atlas/);
  });

  it('is the same name whichever way the path is spelled', () => {
    const spellings = ['/a/b/BOARD.md', 'a/b/BOARD.md', './BOARD.md', 'C:\\a\\b\\BOARD.md', 'file:///a/b/BOARD.md', '/a/b/BOARD.md/'];
    expect(new Set(spellings.map(cleanSource))).toEqual(new Set(['BOARD.md']));
  });
});

describe('cleanSource: a URL is reduced to its host', () => {
  const CASES: Array<[string, string, string]> = [
    ['https://github.com/acme/widgets/pull/12', 'github.com', 'a pull request'],
    ['http://localhost:3000/x', 'localhost', 'a port is not part of a name'],
    ['https://user:secret@example.com:8443/a?b#c', 'example.com', 'credentials in a URL are never kept'],
    ['HTTPS://Example.COM/x', 'Example.COM', 'the scheme in any case, the host as sent'],
    ['s3://bucket/key.json', 'bucket', 'any scheme'],
    ['file:///home/ana/atlas/BOARD.md', 'BOARD.md', 'a file URL has no host: its path is reduced as any path'],
  ];

  it.each(CASES)('%s -> %s (%s)', (sent, stored) => {
    expect(cleanSource(sent)).toBe(stored);
  });

  it('is not fooled by a name that only looks like it has a scheme', () => {
    expect(cleanSource('mcp:remember')).toBe('mcp:remember');
    expect(cleanSource('import:markdown')).toBe('import:markdown');
  });
});

describe('cleanSource: a URL never keeps its credentials', () => {
  // Independent review of PR 388, finding P2: a URL with a userinfo (`user:password@`) and no host came back whole, so the
  // password reached the ledger and the note header. The answer must hold none of the userinfo, whatever else the URL lacks
  // or spells oddly. The marker `pass` / `SECRETPW` is the credential in every row.
  const CASES: Array<[string, string, string]> = [
    // the review's own inputs: userinfo and no host
    ['https://user:pass@', '', 'userinfo and no host'],
    ['https://user:pass@#frag', '', '...and a fragment'],
    ['https://user:pass@?q=1', '', '...and a query'],
    // the same family: what else can follow an empty host
    ['https://user:pass@/', '', 'a path of nothing'],
    ['https://user:pass@:8080', '', 'a port and no host'],
    ['https://user:pass@:8080/x', 'x', 'a port and no host, then a path'],
    ['https://user:pass@/path/BOARD.md', 'BOARD.md', 'no host, then a path'],
    ['file://user:pass@/home/ana/atlas/BOARD.md', 'BOARD.md', 'a file URL with a userinfo'],
    ['https://user@', '', 'a user and no password'],
    ['https://:pass@', '', 'a password and no user'],
    ['https://@', '', 'an empty userinfo'],
    ['ssh://git:secret@', '', 'another scheme'],
    ['HTTPS://USER:PASS@', '', 'the scheme in any case'],
    // the userinfo ends at the LAST `@`: a password may hold an unescaped one
    ['https://user:p@ss@example.com/x', 'example.com', 'a password with an unescaped @, a host'],
    ['https://user:p@ss@', '', '...and no host'],
    ['https://us%40er:pass@example.com', 'example.com', 'an escaped @ in the user'],
    // the same URL, spelled the way a browser also reads it
    ['https:///user:pass@example.com', 'example.com', 'extra separators before the authority of a web scheme'],
    ['https:////user:pass@example.com', 'example.com', 'any run of them'],
    ['https:\\\\user:pass@example.com\\x', 'example.com', 'backslashes'],
    ['https:/\\user:pass@example.com', 'example.com', 'one of each'],
    // a host that is not a plain name
    ['https://user:pass@[::1]:8080/x', '[::1]', 'a bracketed IPv6 host keeps its colons'],
    ['http://[::1]:8080/x', '[::1]', 'IPv6 with no userinfo'],
    // review finding P3: a blank belongs to no host
    ['https:// example.com', 'example.com', 'a blank before the host is not part of it'],
    ['https://exa mple.com/x', 'exa mple.com', 'a blank inside a name stays, as in any name'],
    ['https:// /x', 'x', 'a host of nothing but a blank is no host'],
    // a path is still a path, and its query and fragment are not its name
    ['file:///home/ana/atlas/BOARD.md?raw=1#top', 'BOARD.md', 'a hostless URL: its query and fragment are not its name'],
    ['file:///home/ana/notes@2024.md', 'notes@2024.md', 'an @ in a path is part of a file name, not a credential'],
    ['s3:///bucket/key.json', 'key.json', 'another scheme, no host'],
    // a Windows drive is not a scheme
    ['C:\\\\Users\\\\ana\\\\BOARD.md', 'BOARD.md', 'a drive with doubled backslashes'],
    ['C://Users/ana/BOARD.md', 'BOARD.md', 'a drive with forward slashes'],
    // Second review of PR 388: a scheme that is not a web scheme ends its authority at a `/`, `?` or `#` and nowhere else, so a
    // backslash can be part of its userinfo (a randomised differential against a URL parser found the password stored)
    ['custom://\\user:pass@example.com/x', 'example.com', 'a backslash opens the userinfo of another scheme'],
    ['postgres://\\user:pass@host', 'host', '...with no path'],
    ['custom://us\\er:pass@example.com', 'example.com', 'a backslash inside the userinfo'],
    ['custom://user:p@ss\\word@example.com', 'example.com', 'a backslash between two @'],
    ['custom://user:pass@host\\path', 'host', 'a backslash after the host still ends it'],
    ['smb://server\\share\\x', 'server', 'so does one in a path: the name stays readable'],
    ['file://us\\er:pass@host/x', 'us', 'file is special: a backslash ends its authority'],
    ['file:\\\\server\\share\\x.md', 'server', 'a UNC-style file URL names its server'],
    ['https://us\\er:pass@example.com/x', 'us', 'a web scheme ends its authority at a backslash too: a browser reads the host us'],
  ];

  it.each(CASES)('%s -> %s (%s)', (sent, stored) => {
    expect(cleanSource(sent)).toBe(stored);
    // and the note header, which is built from it
    expect(headerSource(sent)).toBe(headerSource(stored));
  });

  it('holds for every combination of scheme, userinfo, host, path, query and separators', () => {
    const SCHEMES = ['https', 'http', 'ftp', 'ssh', 'postgres', 's3', 'file', 'HTTPS'];
    const SEPARATORS = ['://', ':\\\\'];
    const USERINFOS = ['user:SECRETPW', 'SECRETUSER', ':SECRETPW', 'us%40er:SECRETPW', 'user:p@SECRETPW', 'SECRETUSER:'];
    const HOSTS = ['', 'example.com', '[::1]', 'example.com:8080', ':8080'];
    const SUFFIXES = ['', '/', '/x', '/a/b.md', '?q=1', '#f', '/x?q=1#f'];
    let tried = 0;
    for (const scheme of SCHEMES) for (const separator of SEPARATORS) for (const userinfo of USERINFOS) for (const host of HOSTS) for (const suffix of SUFFIXES) {
      const url = `${scheme}${separator}${userinfo}@${host}${suffix}`;
      // The right answer, not only the absence of the secret: the host without its port, or without one the last component
      // of the path (its query and fragment are not part of it).
      const hostName = host.startsWith('[') ? host : host.split(':')[0];
      const lastOfPath = suffix.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '';
      const expected = hostName !== '' ? hostName : lastOfPath;
      const stored = cleanSource(url);
      if (stored !== expected) expect.fail(`${JSON.stringify(url)} is ${JSON.stringify(stored)}, expected ${JSON.stringify(expected)}`);
      for (const [where, name] of [['the ledger', stored], ['the note header', headerSource(url)]] as const) {
        if (/SECRET/i.test(name)) expect.fail(`${JSON.stringify(url)} kept its credentials in ${where}: ${JSON.stringify(name)}`);
      }
      tried++;
    }
    expect(tried).toBe(SCHEMES.length * SEPARATORS.length * USERINFOS.length * HOSTS.length * SUFFIXES.length);
  });
});

describe('cleanSource: a web URL is a URL however its separators are spelled', () => {
  // Independent review of PR 388, second round (P2): a browser reads `https:/user:pass@example.com`, `https:\user:pass@example.com`
  // and `https:user:pass@example.com` as `https://user:pass@example.com`, and `ftp:/user:secret@` as a URL too. They parsed as a
  // path (one separator) or as a plain name (none), so the whole userinfo reached the ledger. After a web scheme any run of
  // separators opens the authority, none included.
  const CASES: Array<[string, string, string]> = [
    ['https:/user:pass@example.com', 'example.com', 'one slash'],
    ['https:\\user:pass@example.com', 'example.com', 'one backslash'],
    ['https:user:pass@example.com', 'example.com', 'no separator at all'],
    ['ftp:/user:secret@', '', 'one slash, a userinfo and no host'],
    ['ftp:/user:secret@ftp.example.com/pub', 'ftp.example.com', 'one slash, a host and a path'],
    ['HTTPS:/user:pass@Example.COM/x', 'Example.COM', 'the scheme in any case, the host as sent'],
    ['http:user:pass@example.com?q=1#f', 'example.com', 'no separator, a query and a fragment'],
    ['wss:user:pass@example.com:8443/x', 'example.com', 'a port is not part of a name'],
    ['ws:/user:pass@[::1]:8080', '[::1]', 'a bracketed IPv6 host'],
    ['https:/\\user:pass@example.com', 'example.com', 'one of each'],
    ['https:/user:p@ss@example.com', 'example.com', 'a password with an unescaped @'],
    ['https:/user:pass@', '', 'a userinfo and no host'],
    ['https:user:pass@:8080', '', 'a port and no host'],
    ['https:/user:pass@/path/BOARD.md', 'BOARD.md', 'no host, then a path'],
    ['http:/localhost:3000/x', 'localhost', 'no userinfo'],
    ['http:localhost', 'localhost', 'no userinfo and no separator'],
    ['https:', '', 'a scheme alone names no one'],
    ['https:/', '', 'a scheme and a slash name no one'],
    ['https:\\', '', 'a scheme and a backslash name no one'],
    ['ws:executor-3', 'executor-3', 'a name that begins like a web scheme is read as a browser reads it: its host'],
    ['  https://user:pass@example.com/x  ', 'example.com', 'blanks around a URL, which a parser strips'],
    ['\thttps:/user:pass@example.com\n', 'example.com', 'a tab and a line feed around it'],
    [' https:user:pass@example.com', 'example.com', 'a blank before a scheme with no separator'],
  ];

  it.each(CASES)('%s -> %s (%s)', (sent, stored) => {
    expect(cleanSource(sent)).toBe(stored);
    expect(headerSource(sent)).toBe(headerSource(stored));
  });

  it('leaves every other scheme as it was: an authority needs two separators, and fewer is a path', () => {
    // A browser reads these as paths with no host. Reading ONE separator as an authority for every scheme (the first
    // wording of the review) would name `file:/home/ana/atlas/BOARD.md` "home".
    const OTHERS: Array<[string, string, string]> = [
      ['file:/home/ana/atlas/BOARD.md', 'BOARD.md', 'a file URL with one slash'],
      ['custom:/path/to/x', 'x', 'another scheme with one slash'],
      ['crew:/executor-7', 'executor-7', 'a label with a colon and a slash'],
      ['ssh:/path/to/x', 'x', 'a path'],
      ['postgres:/var/lib/db', 'db', 'a path'],
      ['s3:/bucket/key.json', 'key.json', 'a path'],
      ['ssh:executor-1', 'ssh:executor-1', 'a label with a colon'],
      ['s3:bucket', 's3:bucket', 'a label with a colon'],
      ['mcp:remember', 'mcp:remember', 'a label with a colon'],
      ['import:markdown', 'import:markdown', 'a label with a colon'],
      ['git+ssh://git:secret@github.com/acme/widgets.git', 'github.com', 'two separators open an authority, whatever the scheme'],
      ['s3://bucket/key.json', 'bucket', 'two separators open an authority, whatever the scheme'],
    ];
    for (const [sent, stored, why] of OTHERS) expect(cleanSource(sent), `${sent} (${why})`).toBe(stored);
  });
});

describe('cleanSource: it reads a URL the way a URL parser does', () => {
  // Independent review of PR 388, second round: the sweep above only ever spelled a URL with two separators, so it checked this
  // module against its own convention. This one asks Node's WHATWG parser, the reference a browser follows: wherever the parser
  // reads credentials none of them may be stored, and wherever it reads a host the stored source is that host.
  const WEB = ['https', 'http', 'ftp', 'ws', 'wss', 'HTTPS', 'Ftp'];
  const OTHER = ['ssh', 'postgres', 's3', 'file', 'custom', 'git+ssh'];
  // Every run of up to three separators in every order (`/`, `\`, `//`, `/\`, `\/`, `\\`, `///`, `//\`, ...), and two long runs.
  const runs = (length: number): string[] => Array.from({ length: 1 << length }, (_, bits) => Array.from({ length }, (_, i) => ((bits >> i) & 1 ? '\\' : '/')).join(''));
  const OPENERS = ['', ...runs(1), ...runs(2), ...runs(3), '////', '\\\\\\\\'];
  // A backslash in a userinfo is what a browser reads as part of it for any scheme that is not a web scheme (or `file`).
  const USERINFOS = ['user:SECRETPW', 'SECRETUSER', ':SECRETPW', 'us%40er:SECRETPW', 'user:p@SECRETPW', 'SECRETUSER:', 'us\\er:SECRETPW', '\\SECRETUSER:SECRETPW', 'user:p@x\\SECRETPW'];
  const HOSTS = ['', 'example.com', '[::1]', 'example.com:8080', ':8080'];
  const SUFFIXES = ['', '/x', '?q=1', '/x?q=1#f'];
  const parse = (shape: string): URL | null => {
    try { return new URL(shape); } catch { return null; }
  };

  it('stores no credential the parser reads, and stores the host it reads', () => {
    let tried = 0;
    let readWithCredentials = 0;
    let readWithHost = 0;
    for (const scheme of [...WEB, ...OTHER]) for (const opener of OPENERS) for (const userinfo of USERINFOS) for (const host of HOSTS) for (const suffix of SUFFIXES) {
      const shape = `${scheme}:${opener}${userinfo}@${host}${suffix}`;
      const stored = cleanSource(shape);
      const header = headerSource(shape);
      const url = parse(shape);
      const leaked = /SECRET/i.test(stored) || /SECRET/i.test(header);
      tried++;
      if (url !== null && (url.username !== '' || url.password !== '')) {
        readWithCredentials++;
        if (leaked) expect.fail(`${JSON.stringify(shape)} is read as credentials, and the stored source keeps them: ${JSON.stringify(stored)} / ${JSON.stringify(header)}`);
      }
      if (url !== null && url.hostname !== '') {
        readWithHost++;
        // The parser writes a host in lower case; this module keeps it as sent.
        if (stored.toLowerCase() !== url.hostname) expect.fail(`${JSON.stringify(shape)} has the host ${JSON.stringify(url.hostname)} and is stored as ${JSON.stringify(stored)}`);
      }
      // A web scheme is a URL in every spelling, so it keeps nothing of its userinfo whether or not the parser accepts the rest.
      // (Not when the userinfo holds a backslash: a browser ends a web authority there, so the text before it is the host.)
      if (WEB.includes(scheme) && !userinfo.includes('\\') && leaked) expect.fail(`${JSON.stringify(shape)} keeps its credentials: ${JSON.stringify(stored)} / ${JSON.stringify(header)}`);
    }
    expect(tried).toBe((WEB.length + OTHER.length) * OPENERS.length * USERINFOS.length * HOSTS.length * SUFFIXES.length);
    // The sweep must reach what it claims to check: most of its spellings are read as a URL with credentials, or with a host.
    expect(readWithCredentials).toBeGreaterThan(5000);
    expect(readWithHost).toBeGreaterThan(5000);
  });
});

describe('cleanSource: a control character is dropped', () => {
  // Independent review of PR 388, P3: a control character in the source lost the whole fact, because the ledger refuses one in a
  // field, while the note writer kept the entry. It is dropped, not turned into a blank, as a URL parser drops a tab or a newline.
  const CASES: Array<[string, string, string]> = [
    ['/home/ana/BOARD\n.md', 'BOARD.md', 'a newline in the last component of a path'],
    ['/home/ana/BOARD\t.md', 'BOARD.md', 'a tab'],
    ['/home/ana/BOARD\r\n.md', 'BOARD.md', 'a carriage return and a line feed'],
    ['BOARD\n.md', 'BOARD.md', 'a newline in a name'],
    ['bad\x00source', 'badsource', 'a NUL'],
    ['\x1b[0mcursor\x1b[0m', '[0mcursor[0m', 'a terminal escape: its ESC goes, the rest is text'],
    ['cursor\x7f', 'cursor', 'DEL'],
    ['next\x85line', 'nextline', 'a C1 control (NEXT LINE)'],
    ['/home/ana/\x00', 'ana', 'a path whose last component was only a control character'],
    ['\x00\n\t\r\x7f', '', 'nothing but control characters names no one'],
    ['https://exa\nmple.com/x', 'example.com', 'inside the host of a URL'],
    ['ht\ntps://user:pass@example.com', 'example.com', 'inside the scheme, where a URL parser reads the same URL'],
    ['https:/\t/user:pass@example.com', 'example.com', 'between the separators'],
    ['\x01https://user:pass@example.com\x01', 'example.com', 'around a URL'],
  ];

  it.each(CASES)('%j -> %j (%s)', (sent, stored) => {
    expect(cleanSource(sent)).toBe(stored);
  });

  it('reads the URL a parser reads, wherever a tab, a line feed or a carriage return is put in it', () => {
    // A URL parser removes every one of them before it reads, so each of these is the original URL.
    const URLS = ['https://user:SECRETPW@example.com/a/b.md', 'https:user:SECRETPW@example.com', 'ftp:/SECRETUSER@host:21/x?q=1#f', 'ssh://git:SECRETPW@host/x'];
    let tried = 0;
    for (const url of URLS) for (const control of ['\t', '\n', '\r']) for (let at = 0; at <= url.length; at++) {
      const sent = url.slice(0, at) + control + url.slice(at);
      expect(cleanSource(sent), JSON.stringify(sent)).toBe(new URL(sent).hostname);
      expect(headerSource(sent), JSON.stringify(sent)).toBe(headerSource(url));
      tried++;
    }
    expect(tried).toBe(URLS.reduce((n, url) => n + 3 * (url.length + 1), 0));
  });

  it('keeps no control character and no credential, wherever any control character is put in a URL, a path or a name', () => {
    const SENTS = ['https://user:SECRETPW@example.com/a/b.md', '/home/example/SECRETPW/ana/BOARD.md', 'plain-name'];
    const CONTROLS = ['\x00', '\x01', '\x1b', '\x7f', String.fromCharCode(0x85), String.fromCharCode(0x9f), '\t', '\n', '\r', '\v', '\f'];
    let tried = 0;
    for (const base of SENTS) for (const control of CONTROLS) for (let at = 0; at <= base.length; at++) {
      const sent = base.slice(0, at) + control + base.slice(at);
      for (const name of [cleanSource(sent), headerSource(sent)]) {
        if (/\p{Cc}/u.test(name)) expect.fail(`${JSON.stringify(sent)} keeps a control character: ${JSON.stringify(name)}`);
        if (/SECRET/i.test(name)) expect.fail(`${JSON.stringify(sent)} keeps a credential: ${JSON.stringify(name)}`);
      }
      tried++;
    }
    expect(tried).toBe(SENTS.reduce((n, base) => n + CONTROLS.length * (base.length + 1), 0));
  });

  it('holds none after any character it is given, alone or inside a name, a path or a URL', () => {
    const LEDGER_REFUSES = /[\x00-\x1f\x7f]/; // what a ledger field may not hold (memory/lifecycle.ts)
    let tried = 0;
    for (let code = 0; code < 0x10000; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue; // lone surrogates are not characters
      const ch = String.fromCharCode(code);
      for (const sent of [ch, `a${ch}b`, `/x/a${ch}b.md`, `https://ex${ch}ample.com/x`, `https:${ch}user:pw@host`]) {
        const stored = cleanSource(sent);
        if (LEDGER_REFUSES.test(stored) || /\p{Cc}/u.test(stored)) expect.fail(`${JSON.stringify(sent)} is stored as ${JSON.stringify(stored)}`);
        tried++;
      }
    }
    expect(tried).toBeGreaterThan(300_000);
  });
});

describe('cleanSource: a name is bounded', () => {
  it(`is cut at ${MAX_SOURCE_LENGTH} characters, and not before`, () => {
    expect(cleanSource('a'.repeat(MAX_SOURCE_LENGTH))).toBe('a'.repeat(MAX_SOURCE_LENGTH));
    expect(cleanSource('a'.repeat(MAX_SOURCE_LENGTH + 1))).toBe('a'.repeat(MAX_SOURCE_LENGTH));
    expect(cleanSource('a'.repeat(5000))).toBe('a'.repeat(MAX_SOURCE_LENGTH));
  });

  it('counts characters, so a letter outside the BMP is never split', () => {
    const cut = cleanSource('\u{1D49C}'.repeat(MAX_SOURCE_LENGTH + 6)); // MATHEMATICAL SCRIPT CAPITAL A: two UTF-16 units
    expect([...cut]).toHaveLength(MAX_SOURCE_LENGTH);
    expect(cut).toBe('\u{1D49C}'.repeat(MAX_SOURCE_LENGTH));
    expect(/\p{Cs}/u.test(cut)).toBe(false);
  });

  it('leaves no blank at the cut', () => {
    expect(cleanSource(`${'a'.repeat(MAX_SOURCE_LENGTH - 1)} b`)).toBe('a'.repeat(MAX_SOURCE_LENGTH - 1));
  });

  it('bounds the name a long path ends in', () => {
    expect(cleanSource(`/x/${'n'.repeat(100)}.md`)).toBe('n'.repeat(MAX_SOURCE_LENGTH));
    expect(cleanSource(`/home/ana/${'very-long-directory-name/'.repeat(12)}STATE.md`)).toBe('STATE.md');
  });
});

describe('cleanSource: it answers at once, whatever it is given', () => {
  // The MCP endpoint takes a body of up to 1 MB, so a source can be that long. The default 5 s test timeout is the budget.
  const MEGABYTE = 1_000_000;

  it('a megabyte of one letter', () => {
    expect(cleanSource('x'.repeat(MEGABYTE))).toBe('x'.repeat(MAX_SOURCE_LENGTH));
  });

  it('a megabyte of separators', () => {
    expect(cleanSource('/'.repeat(MEGABYTE))).toBe('');
    expect(cleanSource('\\/'.repeat(MEGABYTE / 2))).toBe('');
  });

  it('half a megabyte of directories', () => {
    expect(cleanSource('a/'.repeat(MEGABYTE / 2))).toBe('a');
  });

  it('a megabyte of URL, in every shape that has no host or too many separators', () => {
    expect(cleanSource(`https://user:pass@${'a'.repeat(MEGABYTE)}`)).toBe('a'.repeat(MAX_SOURCE_LENGTH));
    expect(cleanSource(`https://${'u:p@'.repeat(MEGABYTE / 4)}`)).toBe('');
    expect(cleanSource(`https://${'/'.repeat(MEGABYTE)}host`)).toBe('host');
    expect(cleanSource(`file://${'/'.repeat(MEGABYTE)}x`)).toBe('x');
    expect(cleanSource(`https://${'@'.repeat(MEGABYTE)}`)).toBe('');
    expect(cleanSource(`https://${' '.repeat(MEGABYTE)}`)).toBe('');
    // a web scheme with no separator, or a megabyte of them
    expect(cleanSource(`https:${'/'.repeat(MEGABYTE)}host`)).toBe('host');
    expect(cleanSource(`https:${'\\/'.repeat(MEGABYTE / 2)}host`)).toBe('host');
    expect(cleanSource(`https:${'a'.repeat(MEGABYTE)}`)).toBe('a'.repeat(MAX_SOURCE_LENGTH));
    expect(cleanSource(`https:${'u:p@'.repeat(MEGABYTE / 4)}`)).toBe('');
  });

  it('a megabyte of control characters', () => {
    expect(cleanSource('\n'.repeat(MEGABYTE))).toBe('');
    expect(cleanSource('a\x00'.repeat(MEGABYTE / 2))).toBe('a'.repeat(MAX_SOURCE_LENGTH));
    expect(cleanSource(`/x/${'\t/'.repeat(MEGABYTE / 2)}BOARD.md`)).toBe('BOARD.md');
  });

  it('strings that are not valid text', () => {
    for (const odd of ['\ud800', 'a\udc00/b', '\u0000', '\n/\n', '\u2028', 'a\u0000/b.md']) {
      expect(typeof cleanSource(odd), JSON.stringify(odd)).toBe('string');
      expect(typeof headerSource(odd), JSON.stringify(odd)).toBe('string');
    }
  });

  it('headerSource, a megabyte at a time', () => {
    expect(headerSource('x'.repeat(MEGABYTE))).toBe('x'.repeat(MAX_SOURCE_LENGTH));
    expect(headerSource(' .'.repeat(MEGABYTE / 2))).toBe('');
    expect(headerSource('a b '.repeat(MEGABYTE / 4)).length).toBeLessThanOrEqual(MAX_SOURCE_LENGTH);
  });
});

describe('cleanSource: cleaning what was cleaned changes nothing more', () => {
  it('holds for every kind of source', () => {
    const sent = [
      '/home/ana/atlas/BOARD.md', '~/.claude/projects/-home-ana-atlas/memory/t8.md', 'C:\\Users\\ana\\atlas\\BOARD.md',
      'https://github.com/acme/widgets/pull/12', 'file:///home/ana/atlas/BOARD.md', '/home/ana/atlas/', 'Claude Code',
      'mcp:remember', '/Users/ana/Documentos/Lição de casa.md', 'a'.repeat(5000), '\u{1D49C}'.repeat(80),
      `${'a'.repeat(MAX_SOURCE_LENGTH - 1)} b`, '   ', '/', '/home/ana/.claude',
      'https:user:pass@example.com', 'https:/user:pass@', 'ws:executor-3', 'BOARD\n.md', '\x00',
    ];
    for (const s of sent) expect(cleanSource(cleanSource(s)), JSON.stringify(s.slice(0, 40))).toBe(cleanSource(s));
  });
});

describe('headerSource: what a note header stores', () => {
  const CASES: Array<[string, string, string]> = [
    // [what was sent, what the header stores, why]
    ['claude', 'claude', 'a name is as it was'],
    ['executor-3', 'executor-3', 'a hyphen stays'],
    ['Claude Code', 'Claude-Code', 'a space is a hyphen, not nothing'],
    ['mcp:remember', 'mcp-remember', 'so is a colon'],
    ['claude.ai', 'claude-ai', 'and a dot'],
    ['gpt-4.1', 'gpt-4-1', 'and a dot between digits'],
    ['São Paulo', 'São-Paulo', 'letters of any script stay'],
    ['日本語', '日本語', 'letters of any script stay'],
    ['claude+esc', 'claude-esc', 'a source cannot spell the escape mark'],
    ['cursor, UTC-03:00', 'cursor-UTC-03-00', 'a source cannot spell the offset mark'],
    ['a)b', 'a-b', 'a source cannot close the header'],
    ['a\nb', 'ab', 'a control character is dropped, so a source cannot start a line (as the header always did)'],
    ['  claude  ', 'claude', 'blanks at the ends'],
    [' -x- ', 'x', 'no hyphen at either end'],
    ['a - b', 'a-b', 'one hyphen for a run'],
    ['a--b', 'a-b', 'one hyphen for a run'],
    ['!!!', '', 'nothing is a name'],
    ['', '', 'nothing is a name'],
    ['/', '', 'nothing is a name'],
    ['/home/ana/atlas/BOARD.md', 'BOARD-md', 'a path: the name it ends in'],
    ['~/.claude/projects/-home-ana-atlas/memory/t8.md', 't8-md', 'a home path'],
    ['C:\\Users\\ana\\atlas\\BOARD.md', 'BOARD-md', 'a Windows path'],
    ['file:///home/ana/atlas/BOARD.md', 'BOARD-md', 'a file URL'],
    ['./docs/PLAN.md', 'PLAN-md', 'a relative path'],
    ['https://github.com/acme/widgets/pull/12', 'github-com', 'a URL: its host'],
    ['/home/ana/.claude', 'claude', 'a hidden directory'],
    ['crew/executor-7', 'executor-7', 'a label with a slash'],
    ['/Users/ana/My Notes/Plan v2.md', 'Plan-v2-md', 'spaces and a dot'],
  ];

  it.each(CASES)('%s -> %s (%s)', (sent, stored) => {
    expect(headerSource(sent)).toBe(stored);
  });

  it('composes accents first, so a decomposed (macOS) file name keeps its letters', () => {
    // "Lição de casa" as a Mac writes it: c + combining cedilla, a + combining tilde.
    const decomposed = 'Lic\u0327a\u0303o de casa';
    expect(decomposed).not.toBe('Lição de casa');
    expect(headerSource(decomposed)).toBe('Lição-de-casa');
    expect(headerSource(`/Users/ana/${decomposed}.md`)).toBe('Lição-de-casa-md');
  });

  it('drops a combining mark that cannot be composed, and the blanks around it do not double', () => {
    expect(headerSource('x \u0301 y')).toBe('x-y');
  });

  it('keeps a word whole in a script that writes its vowels as combining marks, as the header always did', () => {
    // Devanagari "hindi": three consonants with a vowel sign, a virama and a vowel sign, all of them marks that no accent
    // composition absorbs. They are dropped, never turned into hyphens that would cut the word into its consonants.
    const hindi = '\u0939\u093f\u0928\u094d\u0926\u0940';
    expect(headerSource(hindi)).toBe('\u0939\u0928\u0926');
    expect(headerSource(`/home/ana/${hindi}.md`)).toBe('\u0939\u0928\u0926-md');
  });

  it(`never holds more than ${MAX_SOURCE_LENGTH} characters`, () => {
    expect([...headerSource('a b '.repeat(100))].length).toBeLessThanOrEqual(MAX_SOURCE_LENGTH);
    expect(headerSource('a'.repeat(5000))).toBe('a'.repeat(MAX_SOURCE_LENGTH));
  });

  it('holds only letters, digits and single hyphens between them, for any character it is given', () => {
    // The header's marks (`+esc`, `, UTC-03:00`) are told apart from a name by what a name cannot hold, so this is the
    // invariant a writer must keep: every BMP character alone, in the middle of a name, and every pair of ASCII punctuation.
    const WELL_FORMED = /^(?:[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*)?$/u;
    const samples: string[] = [];
    for (let code = 0; code < 0x3000; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue; // lone surrogates are not characters
      const ch = String.fromCharCode(code);
      samples.push(ch, `a${ch}b`, `${ch}${ch}`);
    }
    const punctuation = [...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ \t\n'];
    for (const a of punctuation) for (const b of punctuation) samples.push(`x${a}${b}y`, `${a}${b}`);
    for (const sample of samples) {
      const stored = headerSource(sample);
      if (!WELL_FORMED.test(stored)) expect.fail(`${JSON.stringify(sample)} became ${JSON.stringify(stored)}`);
    }
    expect(samples.length).toBeGreaterThan(10_000);
  });

  it('is stable: what a header stores is stored again as it is', () => {
    for (const [sent] of CASES) expect(headerSource(headerSource(sent)), JSON.stringify(sent)).toBe(headerSource(sent));
  });
});

describe('productFromUserAgent: the name a client gives itself', () => {
  const CASES: Array<[unknown, string | undefined, string]> = [
    ['claude-code/2.1.289 (external, cli)', 'claude-code', 'a product with a version and a comment'],
    ['mcporter/0.14.0', 'mcporter', 'a product with a version'],
    ['Cursor/0.50.1 VSCode/1.96.0', 'Cursor', 'the first of several products'],
    ['node', 'node', 'a product with no version'],
    ['  codex_cli_rs/0.2  ', 'codex_cli_rs', 'blanks around it'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 'Mozilla', 'a browser says what it says'],
    ['evil/1.0 (+https://example.com/BOARD.md)', 'evil', 'a comment is never read'],
    [['claude-code/2.1.289', 'other/1.0'], 'claude-code', 'a header sent twice: the first'],
    [undefined, undefined, 'no header'],
    [null, undefined, 'no header'],
    [42, undefined, 'not text'],
    [{}, undefined, 'not text'],
    ['', undefined, 'an empty header'],
    ['   ', undefined, 'a blank header'],
    ['/1.0', undefined, 'no product before the version'],
    ['(compatible; unknown client)', undefined, 'only a comment'],
    ['!!!/1.0', undefined, 'a product with no letter or digit'],
    [[], undefined, 'an empty list'],
  ];

  it.each(CASES)('%j -> %s (%s)', (userAgent, product) => {
    expect(productFromUserAgent(userAgent)).toBe(product);
  });
});
