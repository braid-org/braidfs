(provide 'braidfs)

(require 'benchmark)

(defun find-executable (executable)
  (let* ((extra-paths (shell-command-to-string 
                       (format "%s -c 'echo $PATH'" (or (getenv "SHELL") "/bin/sh"))))
         (exec-path (append (split-string extra-paths ":") exec-path)))
    (executable-find executable)))

;; You can customize this with M-x customize-variable RET braidfs-binary-location
(defcustom braidfs-node-location (find-executable "node")
  "Location for bin/node on your filesystem"
  :type 'string
  :group 'braidfs)

(defcustom braidfs-binary-location (find-executable "braidfs")
  "Location for bin/braidfs on your filesystem"
  :type 'string
  :group 'braidfs)

(defvar-local braidfs-last-saved-version nil
  "The version of the file before the user started editing the buffer, as a string.
When non-nil, indicates the buffer is being edited with braidfs.")

;; Define a predicate to check if file is in ~/http directory and doesn't contain #
(defun braidfs-file-in-http-dir-p (&optional filename)
  "Check if FILENAME is within the ~/http directory and doesn't contain #."
  (let ((filename (or filename (buffer-file-name))))
    (and filename
         (string-prefix-p (expand-file-name "~/http/")
                          (expand-file-name filename))
         (not (string-match-p "#" filename)))))

;; Function to run before changes occur
(defun braidfs-before-change-function (begin end)
  "Notice when the buffer is first modified"
  (when (and (braidfs-file-in-http-dir-p)
             ;; Only run it the first time the buffer is modified
             (not braidfs-last-saved-version))
    ;; (message "Starting edit on file in ~/http: %s" filename)

    ;; Extract program and args from braidfs command
    (let* ((program "braidfs")
           (args (list "editing" (expand-file-name (buffer-file-name))))
           (exit-code nil)
           (output "")
           (buffer (current-buffer))
           (filename (buffer-file-name)))
        
      ;; (message "Calling %s with %s" program args)

      ;; Call braidfs editing and capture output
      (with-temp-buffer
        (insert-buffer-substring buffer)

        (message
         "before-change process takes %s"
         (car
          (benchmark-run

              (setq exit-code
                    (apply 'call-process-region
                           (point-min) (point-max)
                           program
                           t            ; delete region
                           (list t nil) ; output to current buffer, no stderr
                           nil          ; don't redisplay during output
                           args))))) 
        (setq output (buffer-string)))
        
      ;; Only store version if exit code is 0
      (if (eq exit-code 0)
          (progn
            (setq braidfs-last-saved-version (string-trim output))

            ;; Since braidfs is going to handle the save, we don't need to
            ;; warn the user that the file has been edited out from
            ;; underneath us.  So clear the modification time.
            (clear-visited-file-modtime)              

            ;; (message "braidfs editing returned: [%s]" braidfs-last-saved-version)
            )
        ;; (message "braidfs editing failed with code %d: %s" exit-code output)
        ))))

(defun braidfs-handling-save-p ()
  (and (braidfs-file-in-http-dir-p)
       braidfs-last-saved-version))
(defun braidfs-before-save-hook ()
  (when (braidfs-handling-save-p)
    (message "clearing visited file modtime")
    (clear-visited-file-modtime)))

;; Function to handle saving files through the normal mechanism
(defun braidfs-write-file-hook ()
  "Hook that runs when saving files. Use normal save mechanism but handle braidfs files specially."
  (when (braidfs-handling-save-p)
        
    ;; Call "braidfs edited" with the parent version and new content
    (let* ((program "braidfs")
           (args (list "edited"
                       (expand-file-name (buffer-file-name))
                       braidfs-last-saved-version))
           (exit-code nil)
           (buffer (current-buffer))
           (output ""))
      
      ;; Run the process and capture output
      (with-temp-buffer
        (message
         "edited took %s"
         (car
          (benchmark-run
              (progn
                (insert-buffer-substring buffer)
                (setq exit-code
                      (apply 'call-process-region
                             (point-min) (point-max)
                             program
                             t          ; delete region
                             (list t nil) ; output to current buffer, no stderr
                             nil          ; don't redisplay during output
                             args))
                (setq output (buffer-string)))))))
        
      (message "braidfs edited returned: %s (exit code: %d)"
               (string-trim output)
               exit-code) 

      ;; If the command was successful then...
      (when (= exit-code 0)

        ;; Reload the file
        (let ((inhibit-message t))
          (revert-buffer t t t))

        ;; Reset braidfs tracking
        (setq braidfs-last-saved-version nil)
      
        ;; Return t to tell emacs that we handled saving the file, so that it
        ;; doesn't try to save it again with the rest of (write-file).
        t))))

;; Reset the braidfs state when a file is opened
(defun braidfs-reset-state ()
  (when (braidfs-file-in-http-dir-p (buffer-file-name))
    (setq braidfs-last-saved-version nil)
    (message "Reset braidfs state for: %s" (buffer-file-name))))

(defun braidfs-post-command-hook ()
  "Check if we did undo back to an unmodified buffer.  If so, check for reload."
  (when (and (braidfs-file-in-http-dir-p)
             braidfs-last-saved-version    ;; Buffer is being edited with braidfs
             (not (buffer-modified-p))     ;; Buffer is no longer modified
             (eq this-command 'undo))      ;; Last command was undo

    ;; Reset braidfs tracking
    (setq braidfs-last-saved-version nil)
    ;; Reload the file to ensure sync with server
    (let ((inhibit-message t))
      (revert-buffer t t t))))

(defvar braidfs-previous-autorevert-value nil)
(defun braidfs-enable ()
  "Installs braidfs hooks to do special things when writing braidfs files"
  (interactive)

  ;; Add hooks
  (add-hook 'before-change-functions 'braidfs-before-change-function)
  (add-hook 'before-save-hook 'braidfs-before-save-hook)
  (add-hook 'find-file-hook 'braidfs-reset-state)
  (add-hook 'write-file-functions 'braidfs-write-file-hook)
  (add-hook 'post-command-hook 'braidfs-post-command-hook)

  (setq braidfs-previous-autorevert-value global-auto-revert-mode)
  (global-auto-revert-mode 1))

(defun braidfs-disable ()
  "Removes braidfs hooks that do special things when writing braidfs files"
  (interactive)

  ;; Remove hooks
  (remove-hook 'before-change-functions 'braidfs-before-change-function)
  (remove-hook 'before-save-hook 'braidfs-before-save-hook)
  (remove-hook 'find-file-hook 'braidfs-reset-state)
  (remove-hook 'write-file-functions 'braidfs-write-file-hook)
  (remove-hook 'post-command-hook 'braidfs-post-command-hook)

  (global-auto-revert-mode
   ;; It enables if we pass nil, and disables if we pass a negative number
   (if braidfs-previous-autorevert-value nil -1)))


;; Love news feed.  Love news feed.  Love news feed.
;; https://x.com/toomim/status/1901508275528487348

(braidfs-enable)