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
};

const BREW_PREFIXES = ['/opt/homebrew', '/usr/local'];
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One glob star per basename is all the catalog needs - no dependency, no
// recursion, and dir-level stars stay out of the data on purpose.
function expand(pattern) {
  const pats = pattern.includes('{brew}')
    ? BREW_PREFIXES.map((p) => pattern.replace('{brew}', p))
    : [pattern];
  const out = [];
  for (const p of pats) {
    if (!p.includes('*')) {
      out.push(p);
      continue;
    }
    const cut = p.lastIndexOf('/');
    const dir = p.slice(0, cut);
    const rx = new RegExp('^' + p.slice(cut + 1).split('*').map(escapeRx).join('.*') + '$');
    try {
      for (const f of readdirSync(dir)) if (rx.test(f)) out.push(dir + '/' + f);
    } catch {
      /* no such dir here */
    }
  }
  return out;
}

/** Candidate patterns for a platform - what the ssh mode expands remotely. */
export function patternsFor(name, platform) {
  const e = APP_CATALOG[name];
  if (!e) return null;
  const pats = e[platform === 'darwin' ? 'darwin' : 'linux'] ?? [];
  return pats.flatMap((p) =>
    p.includes('{brew}') ? BREW_PREFIXES.map((b) => p.replace('{brew}', b)) : [p],
  );
}

/** Readable files for an app on THIS machine. */
export function resolveApp(name, platform) {
  const e = APP_CATALOG[name];
  if (!e) return null;
  const files = [];
  for (const p of e[platform === 'darwin' ? 'darwin' : 'linux'] ?? [])
    for (const f of expand(p)) {
      try {
        accessSync(f, constants.R_OK);
        files.push(f);
      } catch {
        /* absent or unreadable */
      }
    }
  return { name, format: e.format, unit: e.unit, note: e.note, files: [...new Set(files)] };
}
