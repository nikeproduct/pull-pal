class PullPal < Formula
  desc "Git push that checks your branch merges and your tests pass first"
  homepage "https://github.com/nikeproduct/pull-pal"
  version "0.2.0"
  license "MIT"

  # The tarballs contain a single member named exactly "pull-pal" (asserted by
  # scripts/build.ts), which is what `bin.install "pull-pal"` below requires.
  # SHA256s are rewritten on release by .github/workflows/release.yml.
  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/nikeproduct/pull-pal/releases/download/v#{version}/pull-pal-darwin-arm64.tar.gz"
      sha256 "REPLACED_ON_RELEASE_DARWIN_ARM64"
    else
      url "https://github.com/nikeproduct/pull-pal/releases/download/v#{version}/pull-pal-darwin-x64.tar.gz"
      sha256 "REPLACED_ON_RELEASE_DARWIN_X64"
    end
  end

  def install
    bin.install "pull-pal"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/pull-pal --version")
    assert_match "pull-pal", shell_output("#{bin}/pull-pal --help")
  end
end
