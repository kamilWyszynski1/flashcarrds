.PHONY: build run dev-server dev-backend dev-frontend test clean frontend server backend serve-static

FRONTEND := frontend
SERVER   := server

build: frontend server

frontend:
	cd $(FRONTEND) && npm install && npm run build

server:
	cd $(SERVER) && cargo build --release

backend: server

# Serve API + built PWA (default http://localhost:8080; `make run ADDR=0.0.0.0:9000` to change).
ADDR ?= 0.0.0.0:8080
run:
	cd $(SERVER) && FISZKI_ADDR=$(ADDR) FISZKI_DB=../data/fiszki.db FISZKI_STATIC=../frontend/dist ./target/release/fiszki-server

dev-server:
	cd $(SERVER) && FISZKI_ADDR=$(ADDR) FISZKI_DB=../data/fiszki.db cargo run

dev-backend: dev-server

dev-frontend:
	cd $(FRONTEND) && npm run dev

# Serve static PWA build (default http://127.0.0.1:8131). Port 8130 is reserved.
STATIC_PORT ?= 8131
serve-static:
	npx --prefix $(FRONTEND) vite preview --host 127.0.0.1 --port $(STATIC_PORT)

test:
	cd $(SERVER) && cargo test
	cd $(FRONTEND) && npm test

clean:
	rm -rf $(SERVER)/target $(FRONTEND)/dist $(FRONTEND)/node_modules
