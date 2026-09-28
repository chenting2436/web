# FLAC3D slope benchmark asset

`slope_zones_fos_results.csv` is the deterministic 3,000-zone benchmark used by
the slope-stability workbench and its automated tests. It is packaged with the
Python compute service so a clean checkout, container image, or independently
deployed compute service does not depend on a developer workstation path or on
the React application's public asset directory.

The optional `FLAC3D_BENCHMARK_DIRECTORY` environment variable may point to an
operator-supplied benchmark directory. When it is unset, the service uses this
packaged dataset.
