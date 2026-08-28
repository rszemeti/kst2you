FROM debian:bookworm-slim AS build

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential ca-certificates git libncurses-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch master https://github.com/Mictronics/readsb.git /src/readsb \
    && test "$(git -C /src/readsb rev-parse HEAD)" = "e649d2fbb6c9baaa29309cc1ff605948854bdecf" \
    && make -C /src/readsb

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends libgcc-s1 libncurses6 libncursesw6 zlib1g \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/readsb/readsb /usr/local/bin/readsb

ENTRYPOINT ["readsb"]