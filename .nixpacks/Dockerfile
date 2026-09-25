FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067

ENTRYPOINT ["/bin/bash", "-l", "-c"]
WORKDIR /app/


COPY .nixpacks/nixpkgs-31fb21469e34b6b5c7be77b9a35bae43d0c598e9.nix .nixpacks/nixpkgs-31fb21469e34b6b5c7be77b9a35bae43d0c598e9.nix
RUN nix-env -if .nixpacks/nixpkgs-31fb21469e34b6b5c7be77b9a35bae43d0c598e9.nix && nix-collect-garbage -d


ARG CI NIXPACKS_METADATA NODE_ENV NPM_CONFIG_PRODUCTION
ENV CI=$CI NIXPACKS_METADATA=$NIXPACKS_METADATA NODE_ENV=$NODE_ENV NPM_CONFIG_PRODUCTION=$NPM_CONFIG_PRODUCTION

# setup phase
# noop

# install phase
ENV NIXPACKS_PATH=/app/node_modules/.bin:$NIXPACKS_PATH
COPY . /app/.
RUN --mount=type=cache,id=u3fgZDqKw-/root/bun,target=/root/.bun bun i --no-save

# build phase
# noop


RUN printf '\nPATH=/app/node_modules/.bin:$PATH' >> /root/.profile


# start
COPY . /app

CMD ["bun run start"]

