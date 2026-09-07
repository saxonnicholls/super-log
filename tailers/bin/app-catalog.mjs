//
//  app-catalog.mjs - where the well-known apps keep their logs.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The top-20 things a developer actually wants on the bench - databases,
//  web servers, queues - with their default log paths per OS. `{brew}`
//  expands to both Homebrew prefixes, which is how the processor question
//  answers itself: /opt/homebrew on Apple Silicon, /usr/local on Intel,
//  and the existence check keeps whichever is real. Paths here are the
//  DEFAULTS the packages ship with; a custom log_directory needs
//  `superlog-tail file <path>` and that is fine - this catalog exists so
//  the common case is one word.
//
//    superlog-tail apps            # what does THIS machine have?
//    superlog-tail app postgres nginx redis
//

import { accessSync, constants, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

export const APP_CATALOG = {
  postgres: {
    format: 'postgres', unit: 'postgresql',
    darwin: ['{brew}/var/log/postgresql*.log', '{brew}/var/postgresql*/postgresql*.log'],
    linux: ['/var/log/postgresql/postgresql-*.log'],
  },
  mysql: {
    format: 'generic', unit: 'mysql',
    darwin: ['{brew}/var/mysql/*.err', '{brew}/var/log/mysql/error.log'],
    linux: ['/var/log/mysql/error.log', '/var/log/mysqld.log'],
  },
  mariadb: {
    format: 'generic', unit: 'mariadb',
    darwin: ['{brew}/var/mysql/*.err'],
    linux: ['/var/log/mysql/error.log', '/var/log/mariadb/mariadb.log'],
  },
  mongodb: {
    format: 'mongodb', unit: 'mongod',
    darwin: ['{brew}/var/log/mongodb/mongo*.log'],
    linux: ['/var/log/mongodb/mongod.log'],
  },
  redis: {
    format: 'redis', unit: 'redis-server',
    darwin: ['{brew}/var/log/redis*.log'],
    linux: ['/var/log/redis/redis-server.log', '/var/log/redis/redis.log'],
  },
  nginx: {
    format: 'nginx', unit: 'nginx',
    darwin: ['{brew}/var/log/nginx/error.log', '{brew}/var/log/nginx/access.log'],
    linux: ['/var/log/nginx/error.log', '/var/log/nginx/access.log'],
  },
  apache: {
    format: 'apache', unit: 'apache2',
    darwin: ['/var/log/apache2/error_log', '/var/log/apache2/access_log',
             '{brew}/var/log/httpd/error_log'],
    linux: ['/var/log/apache2/error.log', '/var/log/apache2/access.log',
            '/var/log/httpd/error_log'],
  },
  rocksdb: {
    format: 'rocksdb',
    darwin: [], linux: [],
    note: 'embedded - the LOG file lives in your DB directory: superlog-tail file <db-dir>/LOG --format rocksdb',
  },
  kafka: {
    format: 'log4j', unit: 'kafka',
    darwin: ['{brew}/var/log/kafka/kafka_output.log', '{brew}/var/log/kafka/server.log'],
    linux: ['/var/log/kafka/server.log', '/opt/kafka/logs/server.log'],
  },
  zookeeper: {
    format: 'log4j', unit: 'zookeeper',
    darwin: ['{brew}/var/log/zookeeper/zookeeper.log'],
    linux: ['/var/log/zookeeper/zookeeper.log'],
  },
  elasticsearch: {
    format: 'log4j', unit: 'elasticsearch',
    darwin: ['{brew}/var/log/elasticsearch/elasticsearch.log', '{brew}/var/log/elasticsearch.log'],
    linux: ['/var/log/elasticsearch/elasticsearch.log'],
  },
  rabbitmq: {
    format: 'generic', unit: 'rabbitmq-server',
    darwin: ['{brew}/var/log/rabbitmq/rabbit@*.log'],
    linux: ['/var/log/rabbitmq/rabbit@*.log'],
  },
  clickhouse: {
    format: 'generic', unit: 'clickhouse-server',
    darwin: ['{brew}/var/log/clickhouse-server/*.log'],
    linux: ['/var/log/clickhouse-server/clickhouse-server.log',
            '/var/log/clickhouse-server/clickhouse-server.err.log'],
  },
  docker: {
    format: 'generic', unit: 'docker',
    darwin: [], linux: ['/var/log/docker.log'],
    note: 'on systemd hosts the daemon logs to journald: superlog-tail os-linux --unit docker',
  },
  caddy: {
    format: 'generic', unit: 'caddy',
    darwin: ['{brew}/var/log/caddy.log'],
    linux: ['/var/log/caddy/caddy.log', '/var/log/caddy/access.log'],
  },
  haproxy: {
    format: 'generic', unit: 'haproxy',
    darwin: [], linux: ['/var/log/haproxy.log'],
  },
  'php-fpm': {
    format: 'generic', unit: 'php-fpm',
    darwin: ['{brew}/var/log/php-fpm.log'],
    linux: ['/var/log/php*-fpm.log', '/var/log/php-fpm/error.log'],
  },
  gunicorn: {
    format: 'generic',
    darwin: [], linux: ['/var/log/gunicorn/error.log', '/var/log/gunicorn/gunicorn.log'],
  },
  supervisor: {
    format: 'generic', unit: 'supervisor',
    darwin: ['{brew}/var/log/supervisord.log'],
    linux: ['/var/log/supervisor/supervisord.log'],
  },
  celery: {
    format: 'generic',
    darwin: [], linux: ['/var/log/celery/*.log'],
  },
  // ---- engines and content tools: their logs live under $HOME, not /var.
  // A stuck light bake or a shader that will not compile is the same
  // debugging problem as a failing service, in a tool with worse logs.
  unity: {
    format: 'unity',
    darwin: ['{home}/Library/Logs/Unity/Editor.log'],
    linux: ['{home}/.config/unity3d/Editor.log'],
    note: 'the Editor log. A built game writes Player.log per company/product: superlog-tail file <path> --format unity',
  },
  unreal: {
    format: 'unreal',
    darwin: ['{home}/Library/Logs/Unreal Engine/*/*.log'],
    linux: ['{home}/.config/Epic/UnrealEngine/*/Saved/Logs/*.log'],
    // Rotated copies and the launcher's embedded Chromium: dormant files
    // that would each hold a tail open for logs that can never move again.
    exclude: /-backup-|cef3/,
    note: 'editor logs, one dir per project. A packaged game logs to <Project>/Saved/Logs: superlog-tail file <path> --format unreal',
  },
  blender: {
    format: 'generic',
    darwin: [], linux: [],
    note: 'logs to stdout, not a file: blender -b scene.blend -a 2>&1 | superlog --topic app.<host>.blender',
  },
  autocad: {
    format: 'generic',
    darwin: [], linux: [],
    note: 'Windows-first: LOGFILEMODE 1 makes it write the .log that LOGFILENAME names - tail that (over ssh if remote)',
  },
};

const BREW_PREFIXES = ['/opt/homebrew', '/usr/local'];
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Segment-wise globbing, no dependency: a star never crosses a slash, and
// each starred segment is one readdir. Directory-level stars used to stay
// out of the data on purpose, until Unreal - which keeps one log directory
// PER PROJECT, so the only honest default path has a star in the middle.
function glob(p) {
  if (!p.includes('*')) return [p];
  const parts = p.split('/');
  const i = parts.findIndex((s) => s.includes('*'));
  const dir = parts.slice(0, i).join('/') || '/';
  const rx = new RegExp('^' + parts[i].split('*').map(escapeRx).join('.*') + '$');
  const rest = parts.slice(i + 1).join('/');
  const out = [];
  try {
    for (const f of readdirSync(dir))
      if (rx.test(f)) out.push(...(rest ? glob(`${dir}/${f}/${rest}`) : [`${dir}/${f}`]));
  } catch {
    /* no such dir here */
  }
  return out;
}

function expand(pattern) {
  const withHome = pattern.replace('{home}', homedir());
  const pats = withHome.includes('{brew}')
    ? BREW_PREFIXES.map((p) => withHome.replace('{brew}', p))
    : [withHome];
  return pats.flatMap(glob);
}

/** Candidate patterns for a platform - what the ssh mode expands remotely.
 *  {home} becomes ~ so the REMOTE shell resolves it to the remote home,
 *  not this machine's. */
export function patternsFor(name, platform) {
  const e = APP_CATALOG[name];
  if (!e) return null;
  const pats = e[platform === 'darwin' ? 'darwin' : 'linux'] ?? [];
  return pats.flatMap((p) =>
    p.includes('{brew}') ? BREW_PREFIXES.map((b) => p.replace('{brew}', b)) : [p],
  ).map((p) => p.replace('{home}', '~'));
}

/** Readable files for an app on THIS machine. */
export function resolveApp(name, platform) {
  const e = APP_CATALOG[name];
  if (!e) return null;
  const files = [];
  for (const p of e[platform === 'darwin' ? 'darwin' : 'linux'] ?? [])
    for (const f of expand(p)) {
      if (e.exclude?.test(f)) continue;
      try {
        accessSync(f, constants.R_OK);
        files.push(f);
      } catch {
        /* absent or unreadable */
      }
    }
  return { name, format: e.format, unit: e.unit, note: e.note, files: [...new Set(files)] };
}
