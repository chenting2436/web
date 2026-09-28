package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type StateStore struct {
	mu     sync.RWMutex
	path   string
	values map[string]map[string]any
}

func NewStateStore(path string) *StateStore {
	state := &StateStore{path: path, values: make(map[string]map[string]any)}
	if path == "" {
		return state
	}

	data, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(data, &state.values)
	}
	return state
}

func (state *StateStore) Get(scope, slug string) map[string]any {
	state.mu.RLock()
	defer state.mu.RUnlock()
	return cloneState(state.values[stateKey(scope, slug)])
}

func (state *StateStore) Put(scope, slug string, value map[string]any) error {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.values[stateKey(scope, slug)] = cloneState(value)
	return state.persistLocked()
}

func (state *StateStore) persistLocked() error {
	if state.path == "" {
		return nil
	}
	directory := filepath.Dir(state.path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state.values, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, "workbench-state-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, state.path); err == nil {
		return nil
	}
	// Windows does not replace an existing destination with Rename.
	if err := os.Remove(state.path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.Rename(temporaryPath, state.path)
}

func stateKey(scope, slug string) string {
	return scope + "|" + slug
}

func cloneState(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	data, err := json.Marshal(value)
	if err != nil {
		return map[string]any{}
	}
	var clone map[string]any
	if err := json.Unmarshal(data, &clone); err != nil {
		return map[string]any{}
	}
	return clone
}
