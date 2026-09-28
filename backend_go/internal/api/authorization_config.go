package api

import (
	"errors"
	"strings"

	"skyviewlab/backend_go/internal/authorization"
	"skyviewlab/backend_go/internal/authorization/openfga"
)

func buildAuthorizer(config Config) (authorization.Authorizer, error) {
	if config.Authorizer != nil {
		return config.Authorizer, nil
	}
	if config.DevAuthorizationFallback {
		return authorization.LocalFallback{}, nil
	}
	return openfga.New(openfga.Config{
		APIURL: config.OpenFGAAPIURL, StoreID: config.OpenFGAStoreID,
		AuthorizationModelID: config.OpenFGAAuthorizationModelID,
		APIToken:             config.OpenFGAAPIToken, ExpectedModelSHA256: config.OpenFGAExpectedModelSHA256,
		Timeout: config.OpenFGATimeout, AllowInsecureHTTP: config.OpenFGAAllowInsecureHTTP,
	}, nil)
}

func validateAuthorizationConfig(config Config) error {
	values := []string{
		config.OpenFGAAPIURL, config.OpenFGAStoreID, config.OpenFGAAuthorizationModelID,
		config.OpenFGAAPIToken, config.OpenFGAExpectedModelSHA256,
	}
	hasOpenFGAValue := config.OpenFGAAllowInsecureHTTP
	for _, value := range values {
		hasOpenFGAValue = hasOpenFGAValue || strings.TrimSpace(value) != ""
	}
	if config.Authorizer != nil {
		if !config.DevMode {
			return errors.New("injected authorizer is test/development-only; production requires OpenFGA")
		}
		if config.DevAuthorizationFallback || hasOpenFGAValue {
			return errors.New("injected authorizer cannot be combined with OpenFGA or local fallback configuration")
		}
		return nil
	}
	if config.DevAuthorizationFallback {
		if !config.DevMode {
			return errors.New("local authorization fallback is forbidden outside development")
		}
		if hasOpenFGAValue {
			return errors.New("local authorization fallback cannot be combined with OpenFGA configuration")
		}
		return nil
	}
	if strings.TrimSpace(config.OpenFGAAPIURL) == "" || strings.TrimSpace(config.OpenFGAStoreID) == "" || strings.TrimSpace(config.OpenFGAAuthorizationModelID) == "" {
		return errors.New("OpenFGA API URL, store id, and authorization model id are required unless the explicit development fallback is enabled")
	}
	if config.OpenFGAAllowInsecureHTTP && !config.DevMode {
		return errors.New("OpenFGA insecure HTTP is development-only")
	}
	if !config.DevMode && strings.TrimSpace(config.OpenFGAAPIToken) == "" {
		return errors.New("production OpenFGA requires a non-empty preshared API token")
	}
	if !config.DevMode && len(strings.TrimSpace(config.OpenFGAAPIToken)) < 32 {
		return errors.New("production OpenFGA preshared API token must contain at least 32 characters")
	}
	if !config.DevMode && strings.TrimSpace(config.OpenFGAExpectedModelSHA256) == "" {
		return errors.New("production OpenFGA requires a pinned authorization model SHA-256")
	}
	_, err := openfga.New(openfga.Config{
		APIURL: config.OpenFGAAPIURL, StoreID: config.OpenFGAStoreID,
		AuthorizationModelID: config.OpenFGAAuthorizationModelID,
		APIToken:             config.OpenFGAAPIToken, ExpectedModelSHA256: config.OpenFGAExpectedModelSHA256,
		Timeout: config.OpenFGATimeout, AllowInsecureHTTP: config.OpenFGAAllowInsecureHTTP,
	}, nil)
	return err
}
