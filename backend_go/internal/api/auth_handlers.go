package api

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	oidcauth "skyviewlab/backend_go/internal/auth/oidc"
	"skyviewlab/backend_go/internal/model"
	"skyviewlab/backend_go/internal/store"
)

const oidcStateCookie = "skyviewlab_oidc_state"

func (service *server) handleLogin(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		Account  string `json:"account"`
		Password string `json:"password"`
	}
	if err := decodeJSON(response, request, &payload); err != nil {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_LOGIN_REQUEST", err.Error())
		return
	}
	if !service.config.DevMode {
		writeCodedError(response, request, http.StatusServiceUnavailable, "IDENTITY_PROVIDER_REQUIRED", "生产环境身份源尚未配置")
		return
	}

	account := strings.TrimSpace(payload.Account)
	adminMatch := service.config.DemoAccount != "" && secureEqual(account, service.config.DemoAccount) && secureEqual(payload.Password, service.config.DemoPassword)
	studentMatch := service.config.StudentAccount != "" && secureEqual(account, service.config.StudentAccount) && secureEqual(payload.Password, service.config.StudentPassword)
	if !adminMatch && !studentMatch {
		_ = service.audit(request, "auth.login", "session", "", "denied", "", "", map[string]any{"accountHash": hashValue(strings.ToLower(account))})
		writeCodedError(response, request, http.StatusUnauthorized, "AUTH_INVALID_CREDENTIALS", "账号或密码不正确")
		return
	}

	displayName, role := "管理员", "admin"
	if studentMatch {
		displayName, role = "虚拟学生", "student"
	}
	identity, err := service.projects.EnsureDevIdentity(service.config.DevTenantID, service.config.DevWorkspaceID, account, displayName, role)
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "IDENTITY_BOOTSTRAP_FAILED", "无法创建开发身份")
		return
	}
	session, stage, err := service.issueSession(response, request, identity, map[string]any{"provider": "development-local"})
	if err != nil {
		service.writeSessionError(response, request, stage)
		return
	}
	writeData(response, request, http.StatusOK, session)
}

func (service *server) handleOIDCStart(response http.ResponseWriter, request *http.Request) {
	if service.oidc == nil {
		writeCodedError(response, request, http.StatusServiceUnavailable, "OIDC_NOT_CONFIGURED", "企业身份登录尚未配置")
		return
	}
	if allowed, retryAfter := service.oidcStart.Allow(oidcSourcePrefix(request.RemoteAddr)); !allowed {
		writeOIDCRateLimit(response, request, retryAfter)
		return
	}
	authorization, err := service.oidc.Begin(request.Context())
	if err != nil {
		if errors.Is(err, oidcauth.ErrFlowCapacity) || errors.Is(err, oidcauth.ErrFlowRateLimited) {
			writeOIDCRateLimit(response, request, 30*time.Second)
			return
		}
		if errors.Is(err, oidcauth.ErrTransactionStore) {
			writeCodedError(response, request, http.StatusServiceUnavailable, "OIDC_FLOW_UNAVAILABLE", "无法创建企业登录流程")
			return
		}
		writeCodedError(response, request, http.StatusBadGateway, "OIDC_PROVIDER_UNAVAILABLE", "企业身份服务暂不可用")
		return
	}
	maxAge := durationMaxAgeSeconds(authorization.TTL)
	if maxAge < 1 {
		_ = service.oidc.AbortContext(request.Context(), authorization.State)
		writeCodedError(response, request, http.StatusServiceUnavailable, "OIDC_FLOW_UNAVAILABLE", "无法创建企业登录流程")
		return
	}
	http.SetCookie(response, &http.Cookie{
		Name: oidcStateCookie, Value: authorization.State, Path: "/", HttpOnly: true,
		Secure: service.config.CookieSecure, SameSite: http.SameSiteLaxMode,
		Expires: authorization.ExpiresAt, MaxAge: maxAge,
	})
	http.Redirect(response, request, authorization.URL, http.StatusFound)
}

func writeOIDCRateLimit(response http.ResponseWriter, request *http.Request, retryAfter time.Duration) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Retry-After", strconv.Itoa(durationMaxAgeSeconds(retryAfter)))
	writeCodedError(response, request, http.StatusTooManyRequests, "OIDC_RATE_LIMITED", "企业登录请求过于频繁，请稍后重试")
}

func (service *server) handleOIDCCallback(response http.ResponseWriter, request *http.Request) {
	if service.oidc == nil {
		writeCodedError(response, request, http.StatusServiceUnavailable, "OIDC_NOT_CONFIGURED", "企业身份登录尚未配置")
		return
	}
	state, stateOK := singleQueryValue(request.URL.Query(), "state")
	correlation, cookieErr := request.Cookie(oidcStateCookie)
	service.clearOIDCStateCookie(response)
	if cookieErr != nil || !stateOK || !secureEqual(state, correlation.Value) {
		if cookieErr == nil {
			_ = service.oidc.AbortContext(request.Context(), correlation.Value)
		}
		writeCodedError(response, request, http.StatusUnauthorized, "OIDC_STATE_INVALID", "登录状态无效或已过期")
		return
	}
	query := request.URL.Query()
	providerError, validProviderError := singleQueryValue(query, "error")
	_, providerErrorPresent := query["error"]
	code, codeOK := singleQueryValue(query, "code")
	if providerErrorPresent {
		_ = service.oidc.AbortContext(request.Context(), state)
		if !validProviderError {
			writeCodedError(response, request, http.StatusBadRequest, "OIDC_CALLBACK_INVALID", "企业登录回调参数无效")
			return
		}
		_ = providerError
		writeCodedError(response, request, http.StatusUnauthorized, "OIDC_AUTHORIZATION_DENIED", "企业身份服务未完成授权")
		return
	}
	if !codeOK {
		_ = service.oidc.AbortContext(request.Context(), state)
		writeCodedError(response, request, http.StatusBadRequest, "OIDC_CALLBACK_INVALID", "企业登录回调缺少授权码")
		return
	}
	principal, err := service.oidc.Exchange(request.Context(), state, code)
	if err != nil {
		if errors.Is(err, oidcauth.ErrInvalidState) || errors.Is(err, oidcauth.ErrInvalidToken) {
			writeCodedError(response, request, http.StatusUnauthorized, "OIDC_TOKEN_INVALID", "企业身份令牌验证失败")
			return
		}
		if errors.Is(err, oidcauth.ErrTransactionStore) {
			writeCodedError(response, request, http.StatusServiceUnavailable, "OIDC_FLOW_UNAVAILABLE", "企业登录状态存储暂不可用")
			return
		}
		writeCodedError(response, request, http.StatusBadGateway, "OIDC_PROVIDER_UNAVAILABLE", "企业身份服务暂不可用")
		return
	}
	identity, err := service.projects.ResolveOIDCIdentityWithAudit(request.Context(),
		principal.Issuer, principal.Subject, principal.TenantID, principal.WorkspaceID, principal.Email,
		func(identity store.Identity) store.AuditEvent {
			auditRequest := request.WithContext(withIdentity(request, identity))
			return service.auditEvent(auditRequest, "auth.oidc.bind", "external_identity", identity.UserID, "success", "", hashValue(identity), map[string]any{
				"issuerHash": hashValue(principal.Issuer), "subjectHash": hashValue(principal.Subject),
			})
		},
	)
	if err != nil {
		if errors.Is(err, store.ErrOIDCIdentityNotProvisioned) || errors.Is(err, store.ErrOIDCIdentityConflict) {
			writeCodedError(response, request, http.StatusForbidden, "OIDC_IDENTITY_NOT_PROVISIONED", "该身份尚未获得此工作区访问权限")
			return
		}
		if errors.Is(err, store.ErrAtomicAuditWrite) {
			writeCodedError(response, request, http.StatusInternalServerError, "AUDIT_WRITE_FAILED", "无法记录身份绑定审计")
			return
		}
		writeCodedError(response, request, http.StatusInternalServerError, "OIDC_IDENTITY_MAPPING_FAILED", "无法映射企业身份")
		return
	}
	_, stage, err := service.issueSession(response, request, identity, map[string]any{
		"provider": "oidc", "issuerHash": hashValue(principal.Issuer), "subjectHash": hashValue(principal.Subject),
	})
	if err != nil {
		service.writeSessionError(response, request, stage)
		return
	}
	http.Redirect(response, request, service.config.OIDCWebReturnURL, http.StatusSeeOther)
}

func (service *server) issueSession(response http.ResponseWriter, request *http.Request, identity store.Identity, metadata map[string]any) (model.AuthSession, string, error) {
	token, err := randomToken()
	if err != nil {
		return model.AuthSession{}, "create", err
	}
	tokenHash := hashToken(token)
	auditRequest := request.WithContext(withIdentity(request, identity))
	event := service.auditEvent(auditRequest, "auth.login", "session", tokenHash[:16], "success", "", hashValue(identity), metadata)
	expiresAt, err := service.projects.CreateSessionWithAudit(request.Context(), tokenHash, identity, service.config.SessionTTL, event)
	if err != nil {
		if errors.Is(err, store.ErrAtomicAuditWrite) {
			return model.AuthSession{}, "audit", err
		}
		return model.AuthSession{}, "create", err
	}
	http.SetCookie(response, &http.Cookie{
		Name: sessionCookie, Value: token, Path: "/", HttpOnly: true,
		Secure: service.config.CookieSecure, SameSite: http.SameSiteLaxMode,
		Expires: expiresAt, MaxAge: durationMaxAgeSeconds(service.config.SessionTTL),
	})
	return model.AuthSession{User: userModel(identity), ExpiresAt: expiresAt.Format(time.RFC3339)}, "", nil
}

func durationMaxAgeSeconds(duration time.Duration) int {
	seconds := int(duration / time.Second)
	if duration%time.Second != 0 {
		seconds++
	}
	return seconds
}

func (service *server) writeSessionError(response http.ResponseWriter, request *http.Request, stage string) {
	if stage == "audit" {
		writeCodedError(response, request, http.StatusInternalServerError, "AUDIT_WRITE_FAILED", "无法记录登录审计")
		return
	}
	writeCodedError(response, request, http.StatusInternalServerError, "SESSION_CREATE_FAILED", "无法创建登录会话")
}

func (service *server) clearOIDCStateCookie(response http.ResponseWriter) {
	http.SetCookie(response, &http.Cookie{
		Name: oidcStateCookie, Value: "", Path: "/", HttpOnly: true,
		Secure: service.config.CookieSecure, SameSite: http.SameSiteLaxMode,
		Expires: time.Unix(1, 0), MaxAge: -1,
	})
}

func singleQueryValue(values url.Values, name string) (string, bool) {
	items, exists := values[name]
	if !exists || len(items) != 1 {
		return "", false
	}
	value := strings.TrimSpace(items[0])
	return value, value != ""
}

func validateOIDCReturnURL(raw string, allowHTTP bool) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return errors.New("OIDC_WEB_RETURN_URL must be an absolute URL without credentials or fragment")
	}
	if parsed.Scheme != "https" && !(allowHTTP && parsed.Scheme == "http") {
		return errors.New("OIDC_WEB_RETURN_URL requires HTTPS outside isolated development")
	}
	return nil
}

func (service *server) handleLogout(response http.ResponseWriter, request *http.Request) {
	cookie, _ := request.Cookie(sessionCookie)
	if cookie != nil {
		tokenHash := hashToken(cookie.Value)
		event := service.auditEvent(request, "auth.logout", "session", tokenHash[:16], "success", hashValue(identityFrom(request)), "", nil)
		deleted, err := service.projects.DeleteSessionWithAudit(request.Context(), tokenHash, identityFrom(request), event)
		if err != nil {
			if errors.Is(err, store.ErrAtomicAuditWrite) {
				writeCodedError(response, request, http.StatusInternalServerError, "AUDIT_WRITE_FAILED", "无法记录注销审计")
				return
			}
			writeCodedError(response, request, http.StatusInternalServerError, "SESSION_DELETE_FAILED", "无法注销登录会话")
			return
		}
		if !deleted {
			writeCodedError(response, request, http.StatusUnauthorized, "SESSION_NOT_FOUND", "登录会话已失效")
			return
		}
	} else if err := service.audit(request, "auth.logout", "session", "no-cookie", "success", "", "", nil); err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "AUDIT_WRITE_FAILED", "无法记录注销审计")
		return
	}
	http.SetCookie(response, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", HttpOnly: true,
		Secure: service.config.CookieSecure, SameSite: http.SameSiteLaxMode,
		Expires: time.Unix(1, 0), MaxAge: -1,
	})
	writeData(response, request, http.StatusOK, nil)
}

func (service *server) handleCurrentUser(response http.ResponseWriter, request *http.Request) {
	writeData(response, request, http.StatusOK, userModel(identityFrom(request)))
}

func (service *server) handleAuditEvents(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	identity := identityFrom(request)
	if identity.Role != "admin" {
		writeCodedError(response, request, http.StatusForbidden, "AUDIT_ACCESS_DENIED", "只有管理员可以读取审计事件")
		return
	}
	limit := 100
	if raw := request.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 500 {
			writeCodedError(response, request, http.StatusBadRequest, "INVALID_LIMIT", "limit 必须在 1 至 500 之间")
			return
		}
		limit = parsed
	}
	readEvent := service.auditEvent(request, "audit.events.read", "audit_log", identity.WorkspaceID, "success", "", "", map[string]any{"limit": limit})
	events, err := service.projects.ListVerifiedAuditWithAudit(request.Context(), identity.Scope(), limit, readEvent)
	if errors.Is(err, store.ErrAuditChainInvalid) {
		writeCodedError(response, request, http.StatusServiceUnavailable, "AUDIT_CHAIN_INVALID", "审计记录完整性校验失败")
		return
	}
	if writeAtomicAuditFailure(response, request, err, "无法记录审计读取证据") {
		return
	}
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "AUDIT_READ_FAILED", "无法读取审计事件")
		return
	}
	writeData(response, request, http.StatusOK, events)
}

func withIdentity(request *http.Request, identity store.Identity) context.Context {
	return context.WithValue(request.Context(), identityKey, identity)
}
