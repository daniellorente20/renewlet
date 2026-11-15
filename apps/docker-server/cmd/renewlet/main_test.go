package main

// 静态入口测试保护反代协议识别和 CSP img-src 分流；Docker/反代部署下 HTTP 与 HTTPS 的 Logo 加载策略不能混用。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pocketbase/pocketbase/apis"
)

func TestStaticContentSecurityPolicyUsesExternalProtocol(t *testing.T) {
	httpRequest, err := http.NewRequest(http.MethodGet, "http://renewlet.test/", nil)
	if err != nil {
		t.Fatal(err)
	}
	httpPolicy := staticContentSecurityPolicy(httpRequest, customHeadHTMLConfig{})
	if !strings.Contains(httpPolicy, "img-src 'self' data: blob: http: https:") {
		t.Fatalf("expected HTTP policy to allow http images, got %q", httpPolicy)
	}
	if strings.Contains(httpPolicy, "upgrade-insecure-requests") {
		t.Fatalf("expected HTTP policy not to upgrade insecure requests, got %q", httpPolicy)
	}

	httpsRequest, err := http.NewRequest(http.MethodGet, "http://renewlet.test/", nil)
	if err != nil {
		t.Fatal(err)
	}
	httpsRequest.Header.Set("X-Forwarded-Proto", "https")
	httpsPolicy := staticContentSecurityPolicy(httpsRequest, customHeadHTMLConfig{})
	if !strings.Contains(httpsPolicy, "img-src 'self' data: blob: https:") {
		t.Fatalf("expected HTTPS policy to allow only https images, got %q", httpsPolicy)
	}
	if !strings.Contains(httpsPolicy, "upgrade-insecure-requests") {
		t.Fatalf("expected HTTPS policy to upgrade insecure requests, got %q", httpsPolicy)
	}
}

func TestExternalRequestProtoReadsForwardedBeforeXForwardedProto(t *testing.T) {
	request, err := http.NewRequest(http.MethodGet, "http://renewlet.test/", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Forwarded", `for=192.0.2.60;proto=https;host=renewlet.example, for=198.51.100.17;proto=http`)
	request.Header.Set("X-Forwarded-Proto", "http")

	if got := externalRequestProto(request); got != "https" {
		t.Fatalf("externalRequestProto() = %q, want https", got)
	}
	if got := externalRequestOrigin(request).Host; got != "renewlet.example" {
		t.Fatalf("externalRequestOrigin().Host = %q, want renewlet.example", got)
	}
}

func TestExternalRequestURLUsesForwardedHostForShareLinks(t *testing.T) {
	request, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:3000/api/app/public-status-page", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Forwarded-Proto", "http")
	request.Header.Set("X-Forwarded-Host", "192.168.50.160:5173")

	if got := publicStatusPageURL(request, "public-token"); got != "http://192.168.50.160:5173/status/public-token" {
		t.Fatalf("publicStatusPageURL() = %q", got)
	}
	if got := calendarFeedURL(request, "calendar-token"); got != "http://192.168.50.160:5173/calendar/renewals.ics?token=calendar-token" {
		t.Fatalf("calendarFeedURL() = %q", got)
	}
}

func TestExternalRequestOriginFallsBackWhenForwardedHostIsInvalid(t *testing.T) {
	request, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:3000/", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Header.Set("X-Forwarded-Host", "bad host")

	origin := externalRequestOrigin(request)
	if origin.Scheme != "https" || origin.Host != "127.0.0.1:3000" {
		t.Fatalf("externalRequestOrigin() = %s://%s, want https://127.0.0.1:3000", origin.Scheme, origin.Host)
	}

	request.Header.Set("X-Forwarded-Host", "renewlet.example:bad")
	if got := externalRequestHost(request); got != "127.0.0.1:3000" {
		t.Fatalf("externalRequestHost() = %q, want request host fallback", got)
	}
}

func TestRequireSameOriginRequestUsesBrowserFetchSiteBehindFNOSProxy(t *testing.T) {
	tests := []struct {
		name      string
		fetchSite string
		origin    string
		wantOK    bool
	}{
		{name: "fnOS browser same origin", fetchSite: "same-origin", origin: "https://office.app.5ddd.com:41381", wantOK: true},
		{name: "cross site", fetchSite: "cross-site", origin: "https://attacker.example"},
		{name: "same site other origin", fetchSite: "same-site", origin: "https://other.example.fnos.net"},
		{name: "direct navigation", fetchSite: "none", origin: "https://watchcow-renewlet-web-1.example.fnos.net"},
		{name: "missing fetch site with matching origin", origin: "https://watchcow-renewlet-web-1.example.fnos.net", wantOK: true},
		{name: "missing fetch site with fnOS origin", origin: "https://office.app.5ddd.com:41381"},
		{name: "missing source origin"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodPost, "http://watchcow-renewlet-web-1.example.fnos.net/api/app/auth/login", nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("X-Forwarded-Proto", "https")
			request.Header.Set("X-Forwarded-Host", "watchcow-renewlet-web-1.example.fnos.net")
			if tt.fetchSite != "" {
				request.Header.Set("Sec-Fetch-Site", tt.fetchSite)
			}
			if tt.origin != "" {
				request.Header.Set("Origin", tt.origin)
			}
			if err := requireSameOriginRequest(request); (err == nil) != tt.wantOK {
				t.Fatalf("requireSameOriginRequest() error = %v, wantOK = %t", err, tt.wantOK)
			}
		})
	}
}

func TestRequireSameOriginRequestRejectsMissingOrMismatchedOrigin(t *testing.T) {
	tests := []struct {
		name    string
		origin  string
		referer string
	}{
		{name: "missing", origin: "", referer: ""},
		{name: "origin mismatch", origin: "https://attacker.example", referer: ""},
		{name: "referer mismatch", origin: "", referer: "https://attacker.example/login"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodPost, "http://127.0.0.1:3000/api/app/auth/login", nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Forwarded", `proto=https;host=fnos.example`)
			if tt.origin != "" {
				request.Header.Set("Origin", tt.origin)
			}
			if tt.referer != "" {
				request.Header.Set("Referer", tt.referer)
			}
			if err := requireSameOriginRequest(request); err == nil {
				t.Fatal("requireSameOriginRequest() accepted an invalid request origin")
			}
		})
	}
}

func TestStaticCacheControlSplitsAssetsFromHTMLFallback(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":                   {Data: []byte("<!doctype html>")},
		"assets/app.abc123.js":         {Data: []byte("console.log('renewlet')")},
		"renewlet-client-bootstrap.js": {Data: []byte("document.documentElement.classList.add('dark')")},
	}
	tests := []struct {
		path string
		want string
	}{
		{path: "/assets/app.abc123.js", want: "public, max-age=31536000, immutable"},
		{path: "/assets/missing.js", want: "no-store"},
		{path: "/", want: "no-store"},
		{path: "/settings", want: "no-store"},
		{path: "/index.html", want: "no-store"},
		{path: "/renewlet-client-bootstrap.js", want: "no-cache"},
	}

	for _, tt := range tests {
		request := httptest.NewRequest(http.MethodGet, tt.path, nil)
		if got := staticCacheControl(request, fsys); got != tt.want {
			t.Fatalf("staticCacheControl(%q) = %q, want %q", tt.path, got, tt.want)
		}
	}
}

func TestStaticFallbackSharesMuxWithProductAPIFallbacks(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	registerRoutes(app, router)
	if err := registerStaticFallback(router, fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html><html><body>renewlet-spa</body></html>")},
		"assets/app.js": {Data: []byte("console.log('renewlet')")},
	}, customHeadHTMLConfig{}); err != nil {
		t.Fatal(err)
	}
	// 组合测试锁住启动期真实 route 形状，避免 SPA fallback 再次与产品 API wildcard 在 ServeMux 注册阶段冲突。
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	serve := func(method string, target string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, target, nil)
		if strings.HasPrefix(req.URL.Path, "/api/app/") && isUnsafeHTTPMethod(method) {
			applyRouteTestSameOrigin(req)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	for _, target := range []string{"/settings", "/status", "/status/public-token"} {
		spa := serve(http.MethodGet, target)
		if spa.Code != http.StatusOK {
			t.Fatalf("expected frontend navigation %s to return 200, got %d: %s", target, spa.Code, spa.Body.String())
		}
		if !strings.Contains(spa.Body.String(), "renewlet-spa") {
			t.Fatalf("expected SPA index fallback for %s, got %s", target, spa.Body.String())
		}
		if got := spa.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Fatalf("expected static security headers for %s, got X-Content-Type-Options=%q", target, got)
		}
		if got := spa.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("expected SPA fallback cache policy for %s, got Cache-Control=%q", target, got)
		}
	}

	asset := serve(http.MethodGet, "/assets/app.js")
	if asset.Code != http.StatusOK {
		t.Fatalf("expected asset request to return 200, got %d: %s", asset.Code, asset.Body.String())
	}
	if got := asset.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("expected immutable asset cache policy, got Cache-Control=%q", got)
	}

	notFound := serve(http.MethodGet, "/api/app/does-not-exist")
	if notFound.Code != http.StatusNotFound {
		t.Fatalf("expected product API fallback 404, got %d: %s", notFound.Code, notFound.Body.String())
	}
	var notFoundBody apiErrorEnvelope
	if err := json.Unmarshal(notFound.Body.Bytes(), &notFoundBody); err != nil {
		t.Fatal(err)
	}
	if notFoundBody.Error.Code != "NOT_FOUND" {
		t.Fatalf("expected NOT_FOUND envelope, got %#v", notFoundBody)
	}

	wrongMethod := serve(http.MethodPost, "/api/app/health")
	if wrongMethod.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected product API fallback 405, got %d: %s", wrongMethod.Code, wrongMethod.Body.String())
	}
	var wrongMethodBody apiErrorEnvelope
	if err := json.Unmarshal(wrongMethod.Body.Bytes(), &wrongMethodBody); err != nil {
		t.Fatal(err)
	}
	if wrongMethodBody.Error.Code != "METHOD_NOT_ALLOWED" {
		t.Fatalf("expected METHOD_NOT_ALLOWED envelope, got %#v", wrongMethodBody)
	}

	postFrontend := serve(http.MethodPost, "/settings")
	if postFrontend.Code != http.StatusNotFound {
		t.Fatalf("expected non-navigation request 404, got %d: %s", postFrontend.Code, postFrontend.Body.String())
	}
	if strings.Contains(postFrontend.Body.String(), "renewlet-spa") {
		t.Fatalf("non-navigation requests must not receive SPA HTML: %s", postFrontend.Body.String())
	}
}
