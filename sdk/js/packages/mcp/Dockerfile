# @super-log/mcp — the stdio MCP server, in a container.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# WHY THIS EXISTS. Directories that verify their listings (Glama, and the
# same pattern elsewhere) start the server in a container and send it an MCP
# introspection request. They will not take our word that it works, which is
# the right instinct: most of an MCP directory is servers nobody has run.
#
# WHAT IT IS NOT. This is not how anyone should deploy super-log. The hub is
# a local process and this server talks to it over loopback — in a container
# with no hub, the tools answer honestly that the bench is unreachable, and
# `initialize` and `tools/list` still work, which is exactly what a directory
# check needs. For real use it is `npx -y @super-log/mcp`, beside the hub.
#
# Zero dependencies and Node >= 18 (package.json), so there is nothing to
# install and no lockfile to honour: the image is the runtime plus four files.

FROM node:22-alpine

# Not root. A verifier runs untrusted images; ours should not ask for more
# than it needs, and this server needs nothing but a stdin and a stdout.
WORKDIR /srv
COPY package.json ./
COPY bin ./bin
COPY guide.json ./

# The hub is somewhere else by definition. Both are overridable at run time;
# the defaults are what the server would use on a developer's own machine.
ENV SUPER_LOG_HUB=http://127.0.0.1:7333
ENV SUPER_LOG_JOURNAL=/srv/journal

USER node

# stdio, so no port is exposed and nothing listens. The transport IS the
# process's stdin and stdout — a container that published a port would be
# advertising something this server does not have.
ENTRYPOINT ["node", "/srv/bin/superlog-mcp.mjs"]
