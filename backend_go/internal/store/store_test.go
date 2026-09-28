package store

import (
	"math"
	"testing"
)

func TestMemoryStoreListRejectsIntegerOverflowAsEmptyPage(t *testing.T) {
	catalog := NewMemoryStore()

	page := catalog.List(math.MaxInt, 9)
	if len(page.Items) != 0 {
		t.Fatalf("an out-of-range page must be empty, got %d items", len(page.Items))
	}
	if page.Page != math.MaxInt || page.PageSize != 9 || page.Total != 26 {
		t.Fatalf("unexpected pagination metadata: %+v", page)
	}
}

func TestMemoryStoreListSanitizesNonPositiveInternalArguments(t *testing.T) {
	catalog := NewMemoryStore()

	page := catalog.List(0, 0)
	if page.Page != 1 || page.PageSize != 1 || len(page.Items) != 1 {
		t.Fatalf("invalid internal pagination arguments were not bounded: %+v", page)
	}
}

func TestFlac3DSlopeCapabilityUsesPublishedFrontendStatus(t *testing.T) {
	catalog := NewMemoryStore()
	item, ok := catalog.Get("flac3d-slope-stability")
	if !ok {
		t.Fatal("flac3d slope capability is missing")
	}
	if item.Status != "prototype" || !item.ExecutionAllowed {
		t.Fatalf("flac3d slope must be executable with a frontend-supported status: %+v", item)
	}
}
