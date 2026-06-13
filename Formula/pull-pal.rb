class PullPal < Formula
  desc "Git push wrapper: auto-fetches, rebases against default branch, runs tests before pushing"
  homepage "https://github.com/nikeproduct/pull-pal"
  version "0.1.3"
  license "MIT"

  # SHA256s correspond to the v0.1.3 tarballs produced by scripts/build.ts.
  # Regenerate on each release with:
  #   shasum -a 256 dist/tarballs/pull-pal-darwin-*.tar.gz
  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/nikeproduct/pull-pal/releases/download/v#{version}/pull-pal-darwin-arm64.tar.gz"
      sha256 "393c6ce407426350ed9211ea34967e7de0ecaf96a3d6e2e43ecf95819df8e45d"
    else
      url "https://github.com/nikeproduct/pull-pal/releases/download/v#{version}/pull-pal-darwin-x64.tar.gz"
      sha256 "4bb0137fb42a761cf1a249d505438aa643f3ff8cd8ca4d1573206dc6bddd4af3"
    end
  end

  def install
    bin.install "pull-pal"
  end

  test do
    # Should print help and exit 0
    output = shell_output("#{bin}/pull-pal --help")
    assert_match "pull-pal", output
  end
end
