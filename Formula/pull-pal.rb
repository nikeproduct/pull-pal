class PullPal < Formula
  desc "Git push wrapper: auto-fetches, rebases against default branch, runs tests before pushing"
  homepage "https://github.com/judecodes/pull-pal"
  version "0.1.0"
  license "MIT"

  # After running scripts/build.sh and publishing a release, replace
  # PLACEHOLDER_*_SHA256 with the output of:
  #   shasum -a 256 dist/tarballs/pull-pal-darwin-*.tar.gz
  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/judecodes/pull-pal/releases/download/v#{version}/pull-pal-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER_ARM64_SHA256"
    else
      url "https://github.com/judecodes/pull-pal/releases/download/v#{version}/pull-pal-darwin-x64.tar.gz"
      sha256 "PLACEHOLDER_X64_SHA256"
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
