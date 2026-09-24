# super-log's MCP server, for anything that verifies by running it.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# THIS IS NOT HOW TO DEPLOY super-log. The hub is a local process; this image
# exists because MCP directories (Glama and the rest) check a listing by
# starting the server in a container and sending it an introspection request,
# and they build from the REPOSITORY ROOT. The server itself lives in
# sdk/js/packages/mcp and has an identical Dockerfile beside it for anyone
# building from there.
#
# For real use, beside a hub, it is one line and no container:
#
#     npx -y @super-log/mcp
#
# Zero dependencies and Node >= 18, so there is nothing to install: the image
# is the runtime plus four files.

FROM node:22-alpine

WORKDIR /srv
COPY sdk/js/packages/mcp/package.json ./
COPY sdk/js/packages/mcp/bin ./bin
COPY sdk/js/packages/mcp/guide.json ./

# The hub is somewhere else by definition. In a container with no hub the
# tools answer honestly that the bench is unreachable; `initialize` and
# `tools/list` still work, which is what a directory check asks for.
#
# SUPER_LOG_URL, not SUPER_LOG_HUB — bin/superlog-mcp.mjs reads the former.
# The wrong name shipped here first and did nothing, which is the failure
# mode that hides: the default happens to be this same address, so the
# container behaved correctly while anyone overriding SUPER_LOG_HUB to reach
# a real hub was silently ignored.
ENV SUPER_LOG_URL=http://127.0.0.1:7333
ENV SUPER_LOG_JOURNAL=/srv/journal

# A verifier runs untrusted images. This one needs a stdin and a stdout.
USER node

# stdio: the transport IS this process's stdin and stdout, so nothing listens
# and no port is exposed. A container publishing a port would be advertising
# something this server does not have.
ENTRYPOINT ["node", "/srv/bin/superlog-mcp.mjs"]
