package oidc

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"strconv"
	"strings"
	"unicode/utf8"
)

type jwtHeader struct {
	Algorithm string          `json:"alg"`
	KeyID     string          `json:"kid"`
	Critical  []string        `json:"crit"`
	JWK       json.RawMessage `json:"jwk"`
	JWKSetURL string          `json:"jku"`
	X509URL   string          `json:"x5u"`
}

type jwkSet struct {
	Keys []jwk `json:"keys"`
}

type jwk struct {
	KeyType   string   `json:"kty"`
	Use       string   `json:"use"`
	KeyOps    []string `json:"key_ops"`
	Algorithm string   `json:"alg"`
	KeyID     string   `json:"kid"`
	Modulus   string   `json:"n"`
	Exponent  string   `json:"e"`
}

func (client *Client) verifyIDToken(ctx context.Context, metadata providerMetadata, rawToken, accessToken, expectedNonce string) (Principal, error) {
	if len(rawToken) == 0 || len(rawToken) > 64<<10 {
		return Principal{}, ErrInvalidToken
	}
	segments := strings.Split(rawToken, ".")
	if len(segments) != 3 {
		return Principal{}, ErrInvalidToken
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(segments[0])
	if err != nil || len(headerBytes) > 8<<10 {
		return Principal{}, ErrInvalidToken
	}
	var header jwtHeader
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return Principal{}, ErrInvalidToken
	}
	if header.Algorithm != "RS256" || header.KeyID == "" || len(header.KeyID) > 256 || len(header.Critical) != 0 || len(header.JWK) != 0 || header.JWKSetURL != "" || header.X509URL != "" {
		return Principal{}, ErrInvalidToken
	}
	signature, err := base64.RawURLEncoding.DecodeString(segments[2])
	if err != nil {
		return Principal{}, ErrInvalidToken
	}
	keys, err := client.keys(ctx, metadata, false)
	if err != nil {
		return Principal{}, err
	}
	key, found, err := selectRSAKey(keys, header.KeyID)
	if err != nil {
		return Principal{}, err
	}
	if !found {
		keys, err = client.keys(ctx, metadata, true)
		if err != nil {
			return Principal{}, err
		}
		key, found, err = selectRSAKey(keys, header.KeyID)
		if err != nil {
			return Principal{}, err
		}
	}
	if !found {
		return Principal{}, ErrInvalidToken
	}
	digest := sha256.Sum256([]byte(segments[0] + "." + segments[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], signature); err != nil {
		return Principal{}, ErrInvalidToken
	}
	payload, err := base64.RawURLEncoding.DecodeString(segments[1])
	if err != nil || len(payload) > 48<<10 {
		return Principal{}, ErrInvalidToken
	}
	return client.validateClaims(payload, accessToken, expectedNonce)
}

func selectRSAKey(keys jwkSet, keyID string) (*rsa.PublicKey, bool, error) {
	var selected *rsa.PublicKey
	for _, candidate := range keys.Keys {
		if candidate.KeyID != keyID {
			continue
		}
		if candidate.KeyType != "RSA" || candidate.Algorithm != "" && candidate.Algorithm != "RS256" || candidate.Use != "" && candidate.Use != "sig" || len(candidate.KeyOps) > 0 && !contains(candidate.KeyOps, "verify") {
			continue
		}
		publicKey, err := candidate.publicKey()
		if err != nil {
			return nil, false, ErrInvalidToken
		}
		if selected != nil {
			return nil, false, ErrInvalidToken
		}
		selected = publicKey
	}
	return selected, selected != nil, nil
}

func (key jwk) publicKey() (*rsa.PublicKey, error) {
	modulusBytes, err := base64.RawURLEncoding.DecodeString(key.Modulus)
	if err != nil || len(modulusBytes) == 0 {
		return nil, errors.New("invalid RSA modulus")
	}
	modulus := new(big.Int).SetBytes(modulusBytes)
	if modulus.BitLen() < 2048 || modulus.BitLen() > 16384 {
		return nil, errors.New("RSA modulus size is not allowed")
	}
	exponentBytes, err := base64.RawURLEncoding.DecodeString(key.Exponent)
	if err != nil || len(exponentBytes) == 0 || len(exponentBytes) > 4 {
		return nil, errors.New("invalid RSA exponent")
	}
	exponent := 0
	for _, value := range exponentBytes {
		exponent = exponent<<8 | int(value)
	}
	if exponent < 3 || exponent%2 == 0 {
		return nil, errors.New("invalid RSA exponent")
	}
	return &rsa.PublicKey{N: modulus, E: exponent}, nil
}

func (client *Client) validateClaims(payload []byte, accessToken, expectedNonce string) (Principal, error) {
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.UseNumber()
	claims := map[string]any{}
	if err := decoder.Decode(&claims); err != nil {
		return Principal{}, ErrInvalidToken
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Principal{}, ErrInvalidToken
	}
	issuer, ok := stringClaim(claims, "iss")
	if !ok || issuer != client.config.IssuerURL {
		return Principal{}, ErrInvalidToken
	}
	subject, ok := stringClaim(claims, "sub")
	if !ok || subject == "" || len(subject) > 255 || !utf8.ValidString(subject) {
		return Principal{}, ErrInvalidToken
	}
	nonce, ok := stringClaim(claims, "nonce")
	if !ok || !constantStringEqual(nonce, expectedNonce) {
		return Principal{}, ErrInvalidToken
	}

	audiences, ok := audienceClaim(claims["aud"])
	if !ok || !contains(audiences, client.config.ClientID) {
		return Principal{}, ErrInvalidToken
	}
	if _, exists := claims["azp"]; exists {
		authorizedParty, valid := stringClaim(claims, "azp")
		if !valid || authorizedParty != client.config.ClientID {
			return Principal{}, ErrInvalidToken
		}
	}
	if len(audiences) > 1 {
		// Additional audiences require an explicit allowlist. This minimum
		// vertical slice deliberately has none, so multi-audience tokens fail
		// closed even when azp is present.
		return Principal{}, ErrInvalidToken
	}

	expiresAt, ok := integerClaim(claims, "exp")
	if !ok {
		return Principal{}, ErrInvalidToken
	}
	issuedAt, ok := integerClaim(claims, "iat")
	if !ok || issuedAt <= 0 || expiresAt <= issuedAt || expiresAt-issuedAt > int64(client.config.MaxTokenLifetime.Seconds()) {
		return Principal{}, ErrInvalidToken
	}
	now := client.config.Clock().UTC().Unix()
	skew := int64(client.config.ClockSkew.Seconds())
	if now-skew >= expiresAt || issuedAt > now+skew {
		return Principal{}, ErrInvalidToken
	}
	if _, exists := claims["nbf"]; exists {
		notBefore, valid := integerClaim(claims, "nbf")
		if !valid || notBefore > now+skew {
			return Principal{}, ErrInvalidToken
		}
	}

	email, ok := stringClaim(claims, "email")
	verified, verifiedPresent := boolClaim(claims, "email_verified")
	if !ok || strings.TrimSpace(email) == "" || len(email) > 320 || !verifiedPresent || !verified {
		return Principal{}, ErrInvalidToken
	}
	tenantID, ok := stringClaim(claims, client.config.TenantClaim)
	if !ok || !serviceIdentifier(tenantID) {
		return Principal{}, ErrInvalidToken
	}
	workspaceID, ok := stringClaim(claims, client.config.WorkspaceClaim)
	if !ok || !serviceIdentifier(workspaceID) {
		return Principal{}, ErrInvalidToken
	}
	displayName, _ := stringClaim(claims, "name")
	if strings.TrimSpace(displayName) == "" {
		displayName, _ = stringClaim(claims, "preferred_username")
	}
	if strings.TrimSpace(displayName) == "" {
		displayName = email
	}
	if len([]rune(displayName)) > 256 {
		return Principal{}, ErrInvalidToken
	}
	if _, exists := claims["at_hash"]; exists {
		atHash, valid := stringClaim(claims, "at_hash")
		if !valid {
			return Principal{}, ErrInvalidToken
		}
		if accessToken == "" {
			return Principal{}, ErrInvalidToken
		}
		digest := sha256.Sum256([]byte(accessToken))
		expected := base64.RawURLEncoding.EncodeToString(digest[:len(digest)/2])
		if !constantStringEqual(atHash, expected) {
			return Principal{}, ErrInvalidToken
		}
	}
	return Principal{
		Issuer: issuer, Subject: subject, Email: strings.TrimSpace(email),
		DisplayName: strings.TrimSpace(displayName), TenantID: tenantID, WorkspaceID: workspaceID,
	}, nil
}

func stringClaim(claims map[string]any, name string) (string, bool) {
	value, exists := claims[name]
	if !exists {
		return "", false
	}
	text, ok := value.(string)
	return text, ok
}

func boolClaim(claims map[string]any, name string) (bool, bool) {
	value, exists := claims[name]
	if !exists {
		return false, false
	}
	flag, ok := value.(bool)
	return flag, ok
}

func integerClaim(claims map[string]any, name string) (int64, bool) {
	value, exists := claims[name]
	if !exists {
		return 0, false
	}
	number, ok := value.(json.Number)
	if !ok || strings.ContainsAny(number.String(), ".eE") {
		return 0, false
	}
	parsed, err := strconv.ParseInt(number.String(), 10, 64)
	return parsed, err == nil
}

func audienceClaim(value any) ([]string, bool) {
	switch typed := value.(type) {
	case string:
		if typed == "" {
			return nil, false
		}
		return []string{typed}, true
	case []any:
		if len(typed) == 0 || len(typed) > 16 {
			return nil, false
		}
		seen := map[string]struct{}{}
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			text, ok := item.(string)
			if !ok || text == "" {
				return nil, false
			}
			if _, duplicate := seen[text]; duplicate {
				return nil, false
			}
			seen[text] = struct{}{}
			result = append(result, text)
		}
		return result, true
	default:
		return nil, false
	}
}

func serviceIdentifier(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for index, character := range value {
		if character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || index > 0 && strings.ContainsRune("._:@/-", character) {
			continue
		}
		return false
	}
	return true
}

func constantStringEqual(left, right string) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}
