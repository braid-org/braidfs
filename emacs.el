(global-auto-revert-mode 1)

(defvar my-buffer-was-modified nil
  "Flag to track if the buffer has been modified since last save.")

;; Disable prompt about saving when file has changed on disk
(defun my-disable-file-changed-prompt (orig-fun &rest args)
  (cl-letf (((symbol-function 'yes-or-no-p) (lambda (prompt) t))
            ((symbol-function 'y-or-n-p) (lambda (prompt) t)))
    (apply orig-fun args)))

(advice-add 'save-buffer :around #'my-disable-file-changed-prompt)

;; Track file version returned by braidfs
(defvar-local my-braidfs-version nil
  "Stores the version string returned by the 'braidfs editing' command.
When non-nil, indicates the buffer is being edited with braidfs.")

;; Define a predicate to check if file is in ~/http directory and doesn't contain #
(defun my-file-in-http-dir-p (filename)
  "Check if FILENAME is within the ~/http directory and doesn't contain #."
  (when filename
    (let ((http-dir (expand-file-name "~/http/")))
      (and (string-prefix-p http-dir (expand-file-name filename))
           (not (string-match-p "#" filename))))))

;; Function to run before changes occur
(defun my-before-change-function (begin end)
  "This function runs before changes."
  (let ((filename (buffer-file-name))
        (file-buffer (current-buffer)))
    (when (and filename
               (my-file-in-http-dir-p filename)
               (not my-braidfs-version))
      (message "Starting edit on file in ~/http: %s" filename)
      
      ;; Extract program and args from braidfs command
      (let* ((program "braidfs")
             (args (list "editing" (expand-file-name filename)))
             (exit-code nil)
             (output ""))
        
        ;; Call braidfs editing and capture output
        (with-temp-buffer
          (insert-buffer-substring file-buffer)
          (setq exit-code
                (apply 'call-process-region
                       (point-min) (point-max)
                       program
                       t    ; delete region
                       (list t nil)  ; output to current buffer, no stderr
                       nil    ; don't redisplay during output
                       args))
          (setq output (buffer-string)))
        
        ;; Only store version if exit code is 0
        (if (eq exit-code 0)
            (progn
              (setq my-braidfs-version (string-trim output))
              (message "braidfs editing returned: [%s]" my-braidfs-version))
          (message "braidfs editing failed with code %d: %s" exit-code output))))))

;; Add an after-change function to detect when buffer returns to unmodified state
(defun my-after-change-function (begin end length)
  "This function runs after changes to check if buffer returned to unmodified state."
  (when (and (buffer-modified-p)
             (not my-buffer-was-modified))
    (setq my-buffer-was-modified t)))

;; Function to handle saving files through the normal mechanism
(defun my-write-file-hook ()
  "Hook that runs when saving files. Use normal save mechanism but handle braidfs files specially."
  (let ((filename (buffer-file-name))
        (file-buffer (current-buffer))
        (version my-braidfs-version))
    (when (and filename 
               (my-file-in-http-dir-p filename)
               version)
        
      ;; Reset braidfs tracking
      (setq my-braidfs-version nil)
      
      ;; Call braidfs edited with the version and new content
      (let* ((program "braidfs")
             (args (list "edited" 
                                 (expand-file-name filename)
                                 version))
             (exit-code nil)
             (output ""))
        
        ;; Call braidfs edited and capture output
        (with-temp-buffer
          (insert-buffer-substring file-buffer)
          (setq exit-code
                (apply 'call-process-region
                       (point-min) (point-max)
                       program
                       t    ; delete region
                       (list t nil)  ; output to current buffer, no stderr
                       nil   ; don't redisplay during output
                       args))
          (setq output (buffer-string)))
        
        (message "braidfs edited returned: %s (exit code: %d)" (string-trim output) exit-code)

        ;; Only reload the file if the command was successful
        (when (= exit-code 0)
          (let ((inhibit-message t))
            (revert-buffer t t t)))
        
        ;; Return t only if the call-process was successful (exit code 0)
        (= exit-code 0)))))

;; Set up special handling for files in the ~/http directory
(defun my-setup-http-file-mode ()
  "Set up special handling for files in the ~/http directory."
  (when (my-file-in-http-dir-p (buffer-file-name))
    (message "Setting up hooks for http file: %s" (buffer-file-name))
    ;; Add our write-file hook
    (add-hook 'write-file-functions 'my-write-file-hook nil t)))

;; Reset the braidfs state when a file is opened
(defun my-reset-braidfs-state ()
  "Reset the braidfs state when a file is opened."
  (setq my-braidfs-version nil)
  (when (my-file-in-http-dir-p (buffer-file-name))
    (message "Reset braidfs state for: %s" (buffer-file-name))))

(defun my-post-command-check ()
  "Check if buffer was modified but is now back in sync after undo."
  (when (and my-buffer-was-modified       ;; Buffer was previously modified
             (not (buffer-modified-p))    ;; Buffer is no longer modified
             (eq this-command 'undo))     ;; Last command was undo
    (message "Buffer returned to unmodified state through undo")
    ;; Reset braidfs tracking
    (setq my-braidfs-version nil)
    ;; Reload the file to ensure sync with server
    (let ((inhibit-message t))
      (revert-buffer t t t))
    (setq my-buffer-was-modified nil)))

;; Add hooks
(add-hook 'before-change-functions 'my-before-change-function)
(add-hook 'after-change-functions 'my-after-change-function)
(add-hook 'find-file-hook 'my-reset-braidfs-state)
(add-hook 'find-file-hook 'my-setup-http-file-mode)
(add-hook 'post-command-hook 'my-post-command-check)
