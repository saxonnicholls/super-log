# typed: strict
# frozen_string_literal: true

# Homebrew formula for super-log.
#
# This lives here in-repo for review and local testing. To ship it, copy
# it into a tap repository (saxonnicholls/homebrew-tap, path Formula/) and
# push - then `brew install saxonnicholls/tap/super-log` works with no
# clone. Core is deliberately not the target: super-log fetches
# ts-moveables by pinned commit during the build, which Homebrew core's
# audit forbids, and a tap has no review queue we do not control.
#
# Verify locally before shipping:
#   ruby -c packaging/homebrew/super-log.rb
#   brew install --build-from-source packaging/homebrew/super-log.rb
#
class SuperLog < Formula
  desc "One hub for every log stream on a development bench"
  homepage "https://github.com/saxonnicholls/super-log"
  url "https://github.com/saxonnicholls/super-log/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "bcd958d56b536bedd1e288a1460f1da746d6b467f5fee31cc10376753c790178"
  license "MIT"

  depends_on "cmake" => :build
  depends_on "node"

  def install
    # The hub daemon (superlogd) and the SDK headers, via the guarded
    # install rules. The ImGui viewer is left out of the bottle on
    # purpose: it wants a display/GL stack that a headless build host does
    # not have, and the web viewer needs only a browser.
    system "cmake", "-S", ".", "-B", "build",
           "-DCMAKE_BUILD_TYPE=Release",
           "-DSUPER_LOG_INSTALL=ON",
           "-DSUPER_LOG_BUILD_IMGUI_VIEWER=OFF",
           *std_cmake_args
    system "cmake", "--build", "build", "--target", "superlogd"
    system "cmake", "--install", "build"

    # The 40+ tailers are zero-dependency Node scripts. Ship them under
    # libexec and expose each as a wrapper on PATH, so `superlog-otlp`,
    # `superlog-rpc`, `superlog-gas` and friends just work.
    libexec.install Dir["tailers/bin/*"]
    Dir["#{libexec}/superlog-*.mjs"].each do |script|
      name = File.basename(script, ".mjs")
      (bin/name).write <<~SH
        #!/bin/sh
        exec "#{formula_opt_bin("node")}/node" "#{script}" "$@"
      SH
      chmod 0755, bin/name
    end
    (bin/"superlog").write <<~SH
      #!/bin/sh
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/superlog-tee.mjs" "$@"
    SH
    chmod 0755, bin/"superlog"
  end

  service do
    run [opt_bin/"superlogd"]
    keep_alive true
    log_path var/"log/superlog.log"
    error_log_path var/"log/superlog.log"
  end

  test do
    # The hub answers /healthz, and a tailer speaks its help - the two
    # halves a package must actually deliver.
    require "open3"
    port = free_port
    pid = spawn(bin/"superlogd", "--port", port.to_s)
    sleep 2
    begin
      out = shell_output("curl -s http://127.0.0.1:#{port}/healthz")
      assert_match "published", out
    ensure
      Process.kill("TERM", pid)
    end
    assert_match "OTLP", shell_output("#{bin}/superlog-otlp --help 2>&1")
  end
end
