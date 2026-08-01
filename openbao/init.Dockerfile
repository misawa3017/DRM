# Adds jq (needed by init.sh to parse `bao ... -format=json` output) at
# BUILD time, so the openbao-init container never needs live network access
# to Alpine's package mirror at runtime. This matters because the routine
# "container restarted, just re-unseal from already-persisted state"
# recovery path must work even on an internal VM with restricted/firewalled
# outbound access -- it shouldn't depend on reaching an external mirror.
FROM openbao/openbao:latest

# The base image's default USER is the non-root "openbao" user, which can't
# install packages. Switch to root for the install only; the compose file
# still controls which user the container actually runs as at runtime.
USER root
RUN apk add --no-cache jq
