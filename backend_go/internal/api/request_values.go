package api

import (
	"encoding/json"
	"errors"
)

// Optional request values keep "absent" distinct from an explicit JSON null.
// OpenAPI object/string schemas do not admit null, even when the property itself
// is optional.
type optionalObjectValue struct {
	Value   map[string]any
	Present bool
}

func (value *optionalObjectValue) UnmarshalJSON(data []byte) error {
	value.Present = true
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	if decoded == nil {
		return errors.New("对象字段不能为 null")
	}
	value.Value = decoded
	return nil
}

type optionalStringValue struct {
	Value   string
	Present bool
}

func (value *optionalStringValue) UnmarshalJSON(data []byte) error {
	value.Present = true
	var decoded *string
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	if decoded == nil {
		return errors.New("字符串字段不能为 null")
	}
	value.Value = *decoded
	return nil
}
