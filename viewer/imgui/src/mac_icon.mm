//
//  mac_icon.mm - set the macOS dock icon at runtime.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  glfwSetWindowIcon is a no-op on Cocoa - macOS takes its icon from the app
//  bundle, and a bare dev-tool executable has none. Rather than force the
//  viewer to be packaged as an .app just to carry an icon, we set the running
//  application's dock image directly. NSImage decodes the embedded PNG itself,
//  so the dock gets the full-resolution master, not a downscaled taskbar copy.
//

#import <AppKit/AppKit.h>

extern "C" void superlog_set_dock_icon(const unsigned char* png, int len)
{
    @autoreleasepool {
        NSData* data = [NSData dataWithBytes:png length:(NSUInteger)len];
        NSImage* image = [[NSImage alloc] initWithData:data];
        if (image)
            [NSApp setApplicationIconImage:image];
    }
}
