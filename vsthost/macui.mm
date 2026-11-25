// macui.mm: the Mac part of the BeatForge Plugin Host: windows for plugins and the Cocoa main loop.
// Compiled with -fobjc-arc.
#import <Cocoa/Cocoa.h>

typedef void (*CloseFn)(void*);
typedef void (*ResizeFn)(void*, int, int);

@interface BFPluginWindow : NSObject <NSWindowDelegate>
@property(strong) NSWindow* window;
@property(assign) CloseFn onClose;
@property(assign) ResizeFn onResize;
@property(assign) void* user;
@end

@implementation BFPluginWindow
- (BOOL)windowShouldClose:(NSWindow*)sender {
  if (self.onClose) self.onClose(self.user); // the host closes the plugin view, then the window
  return NO;
}
- (void)windowDidResize:(NSNotification*)n {
  NSSize s = self.window.contentView.frame.size;
  if (self.onResize) self.onResize(self.user, (int)s.width, (int)s.height);
}
@end

static NSMutableDictionary<NSValue*, BFPluginWindow*>* gWins;

@interface BFTicker : NSObject
@property(assign) int (*tick)(void);
- (void)fire:(NSTimer*)t;
@end
@implementation BFTicker
- (void)fire:(NSTimer*)t {
  if (!self.tick()) {
    [t invalidate];
    [NSApp stop:nil];
    // stop: only takes effect after an event, so post one
    NSEvent* e = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0];
    [NSApp postEvent:e atStart:YES];
  }
}
@end

extern "C" void* bfMacOpenWindow(const char* title, int w, int h, int resizable, CloseFn onClose, ResizeFn onResize, void* user) {
  NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable;
  if (resizable) style |= NSWindowStyleMaskResizable;
  NSWindow* win = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, w, h) styleMask:style backing:NSBackingStoreBuffered defer:NO];
  win.releasedWhenClosed = NO;
  win.title = [NSString stringWithUTF8String:title ? title : "Plugin"];
  [win center];
  NSView* view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, w, h)];
  win.contentView = view;
  BFPluginWindow* pw = [BFPluginWindow new];
  pw.window = win; pw.onClose = onClose; pw.onResize = onResize; pw.user = user;
  win.delegate = pw;
  if (!gWins) gWins = [NSMutableDictionary new];
  gWins[[NSValue valueWithPointer:(__bridge void*)view]] = pw;
  return (__bridge void*)view;
}

static BFPluginWindow* find(void* view) { return gWins ? gWins[[NSValue valueWithPointer:view]] : nil; }

extern "C" void bfMacResizeWindow(void* view, int w, int h) {
  BFPluginWindow* pw = find(view);
  if (pw) [pw.window setContentSize:NSMakeSize(w, h)];
}

extern "C" void bfMacFront(void* view) {
  BFPluginWindow* pw = find(view);
  if (!pw) return;
  [NSApp activateIgnoringOtherApps:YES];
  [pw.window makeKeyAndOrderFront:nil];
}

extern "C" void bfMacCloseWindow(void* view) {
  BFPluginWindow* pw = find(view);
  if (!pw) return;
  pw.window.delegate = nil;
  [pw.window orderOut:nil];
  [pw.window close];
  [gWins removeObjectForKey:[NSValue valueWithPointer:view]];
}

extern "C" void bfMacRun(int (*tick)(void)) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory]; // windows, but no Dock icon of its own
    BFTicker* t = [BFTicker new];
    t.tick = tick;
    NSTimer* timer = [NSTimer timerWithTimeInterval:0.012 target:t selector:@selector(fire:) userInfo:nil repeats:YES];
    [[NSRunLoop mainRunLoop] addTimer:timer forMode:NSRunLoopCommonModes];
    [NSApp run];
  }
}
