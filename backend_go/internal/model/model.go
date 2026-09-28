package model

type User struct {
	ID          string `json:"id"`
	TenantID    string `json:"tenantId"`
	WorkspaceID string `json:"workspaceId"`
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
	Role        string `json:"role"`
}

type AuthSession struct {
	User      User   `json:"user"`
	ExpiresAt string `json:"expiresAt"`
}

type Workbench struct {
	ID               string         `json:"id"`
	Slug             string         `json:"slug"`
	Title            string         `json:"title"`
	Description      string         `json:"description"`
	UpdatedAt        string         `json:"updatedAt"`
	Status           string         `json:"status"`
	ExecutionAllowed bool           `json:"executionAllowed"`
	State            map[string]any `json:"state"`
}

type WorkbenchSummary struct {
	ID               string `json:"id"`
	Slug             string `json:"slug"`
	Title            string `json:"title"`
	UpdatedAt        string `json:"updatedAt"`
	Status           string `json:"status"`
	ExecutionAllowed bool   `json:"executionAllowed"`
}

type Paginated[T any] struct {
	Items    []T `json:"items"`
	Page     int `json:"page"`
	PageSize int `json:"pageSize"`
	Total    int `json:"total"`
}
