UUID := triptych@doughsay.github.io
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: test install uninstall nested

test:
	node --test

# Symlinks the extension so the nested shell (and, after a logout, the real
# session) can load it. Does not enable it.
install:
	glib-compile-schemas extension/schemas
	mkdir -p $(dir $(EXT_DIR))
	ln -sfn $(CURDIR)/extension $(EXT_DIR)

uninstall:
	rm -f $(EXT_DIR)

nested: install
	scripts/nested.sh
