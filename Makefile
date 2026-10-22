.PHONY: build run dev-backend dev-frontend test clean frontend backend

FRONTEND := frontend
BACKEND  := backend

build: frontend backend

frontend:
	cd $(FRONTEND) && npm install && npm run build

backend:
	cd $(BACKEND) && cargo build --release

# Serve API + built PWA (default http://localhost:8080; `make run ADDR=0.0.0.0:9000` to change).
ADDR ?= 0.0.0.0:8080
run:
	cd $(BACKEND) && FISZKI_ADDR=$(ADDR) FISZKI_DB=../data/fiszki.db FISZKI_STATIC=../frontend/dist ./target/release/fiszki-server

dev-backend:
	cd $(BACKEND) && FISZKI_ADDR=$(ADDR) FISZKI_DB=../data/fiszki.db cargo run

dev-frontend:
	cd $(FRONTEND) && npm run dev

test:
	cd $(BACKEND) && cargo test
	cd $(FRONTEND) && npm test

clean:
	rm -rf $(BACKEND)/target $(FRONTEND)/dist $(FRONTEND)/node_modules
