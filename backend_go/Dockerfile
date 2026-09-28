FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/skyviewlab-api ./cmd/server && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/skyviewlab-worker ./cmd/worker

FROM alpine:3.23
RUN adduser -D -H -u 10001 appuser && mkdir -p /app/data && chown -R 10001:10001 /app
USER appuser
COPY --from=build /out/skyviewlab-api /skyviewlab-api
COPY --from=build /out/skyviewlab-worker /skyviewlab-worker
EXPOSE 8080
ENTRYPOINT ["/skyviewlab-api"]
